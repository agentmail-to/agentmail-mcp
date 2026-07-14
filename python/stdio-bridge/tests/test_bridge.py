from contextlib import asynccontextmanager

import anyio
import httpx
import pytest
from mcp import ClientSession, types
from mcp.server.lowlevel import NotificationOptions
from mcp.server.models import InitializationOptions

from agentmail_mcp.bridge import Bridge, parse_args


class Remote:
    def __init__(self) -> None:
        self.calls = []
        self.started = anyio.Event()
        self.cancelled = anyio.Event()

    async def list_tools(self, *, params=None):
        cursor = params.cursor if params else None
        if cursor is None:
            return types.ListToolsResult(
                tools=[
                    types.Tool(
                        name="echo",
                        description="Remote echo",
                        inputSchema={"type": "object"},
                        outputSchema={"type": "object"},
                    ),
                    types.Tool(name="slow", inputSchema={"type": "object"}),
                    types.Tool(name="remote_error", inputSchema={"type": "object"}),
                    types.Tool(name="network_error", inputSchema={"type": "object"}),
                ],
                nextCursor="2",
            )
        return types.ListToolsResult(
            tools=[types.Tool(name="hidden", inputSchema={"type": "object"})]
        )

    async def call_tool(self, name, arguments, progress_callback=None, meta=None):
        self.calls.append((name, arguments, meta))
        if name == "slow":
            self.started.set()
            try:
                await anyio.sleep_forever()
            finally:
                self.cancelled.set()
        if name == "remote_error":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text="remote error")], isError=True
            )
        if name == "network_error":
            raise httpx.ConnectError("offline")
        if progress_callback:
            await progress_callback(1, 1, "done")
        return types.CallToolResult(
            content=[types.TextContent(type="text", text="ok")],
            structuredContent={"arguments": arguments},
        )


@asynccontextmanager
async def client_for(bridge, message_handler=None):
    client_send, server_receive = anyio.create_memory_object_stream(10)
    server_send, client_receive = anyio.create_memory_object_stream(10)
    options = InitializationOptions(
        server_name="agentmail-mcp",
        server_version="1.0.0",
        capabilities=bridge.server.get_capabilities(NotificationOptions(tools_changed=True), {}),
    )
    async with anyio.create_task_group() as tasks:
        tasks.start_soon(bridge.server.run, server_receive, server_send, options)
        async with ClientSession(
            client_receive, client_send, message_handler=message_handler
        ) as client:
            await client.initialize()
            yield client
        tasks.cancel_scope.cancel()


@pytest.mark.anyio
async def test_dynamic_filtered_tools_and_results():
    bridge = Bridge(frozenset({"echo"}))
    remote = Remote()
    bridge.remote = remote  # type: ignore[assignment]

    async with client_for(bridge) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == ["echo"]
        assert listed.tools[0].outputSchema == {"type": "object"}

        progress = []

        async def on_progress(value, total, message):
            progress.append((value, total, message))

        result = await client.call_tool("echo", {"value": 1}, progress_callback=on_progress)
        assert result.structuredContent == {"arguments": {"value": 1}}
        assert progress == [(1.0, 1.0, "done")]

        rejected = await client.call_tool("hidden", {})
        assert rejected.isError is True
        assert remote.calls == [("echo", {"value": 1}, {"progressToken": 2})]


@pytest.mark.anyio
async def test_remote_tool_errors_and_list_change_are_forwarded():
    notifications = []

    async def receive(message):
        notifications.append(message)

    bridge = Bridge()
    bridge.remote = Remote()  # type: ignore[assignment]

    async with client_for(bridge, receive) as client:
        await client.list_tools()
        result = await client.call_tool("remote_error", {})
        assert result.isError is True
        network_error = await client.call_tool("network_error", {})
        assert network_error.isError is True
        await bridge.remote_message(types.ServerNotification(types.ToolListChangedNotification()))
        await anyio.sleep(0)

    assert any(
        isinstance(message, types.ServerNotification)
        and isinstance(message.root, types.ToolListChangedNotification)
        for message in notifications
    )


@pytest.mark.anyio
async def test_local_cancellation_cancels_the_bridge_wait():
    bridge = Bridge(frozenset({"slow"}))
    remote = Remote()
    bridge.remote = remote  # type: ignore[assignment]

    async with client_for(bridge) as client:
        async def call():
            with pytest.raises(Exception):
                await client.call_tool("slow", {})

        async with anyio.create_task_group() as tasks:
            tasks.start_soon(call)
            await remote.started.wait()
            await client.send_notification(
                types.ClientNotification(
                    types.CancelledNotification(
                        params=types.CancelledNotificationParams(requestId=1, reason="test")
                    )
                )
            )
            await remote.cancelled.wait()
            tasks.cancel_scope.cancel()


def test_cli_uses_environment_and_validates_tools(monkeypatch):
    monkeypatch.setenv("AGENTMAIL_API_KEY", "secret")
    assert parse_args(["--tools", " echo, hidden "]) == (
        "secret",
        frozenset({"echo", "hidden"}),
    )
    with pytest.raises(SystemExit):
        parse_args(["--tools", ","])
