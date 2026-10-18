import argparse
import asyncio
from datetime import datetime, timezone
import os
import sys
from importlib.metadata import version
from typing import Any

import anyio
import httpx
import mcp.server.stdio
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.models import InitializationOptions
from pydantic import BaseModel

from agentmail import AsyncAgentMail, Subscribe

ENDPOINT = "https://mcp.agentmail.to/mcp"
VERSION = version("agentmail-mcp")


class EventBridgeNotification(BaseModel):
    """Wire model for the local extension notification."""

    method: str = "notifications/event-bridge/event"
    params: dict[str, Any]


class Bridge:
    def __init__(self, selected_tools: frozenset[str] | None = None) -> None:
        self.selected_tools = selected_tools
        self.remote: ClientSession | None = None
        self.local_session: Any = None
        self.api_key: str | None = None
        self.event_subscriptions: dict[tuple[str, tuple[str, ...]], int] = {}
        self.event_task: asyncio.Task[None] | None = None
        self.server = Server("agentmail-mcp", VERSION)
        self.server.list_tools()(self.list_tools)
        self.server.call_tool()(self.call_tool)

    async def list_tools(self) -> list[types.Tool]:
        self.local_session = self.server.request_context.session
        tools: list[types.Tool] = []
        cursor = None
        while True:
            params = types.PaginatedRequestParams(cursor=cursor) if cursor else None
            result = await self._remote().list_tools(params=params)
            tools.extend(result.tools)
            cursor = result.nextCursor
            if not cursor:
                break
        if self.selected_tools is not None:
            tools = [tool for tool in tools if tool.name in self.selected_tools]
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        if name == "_event_bridge_subscribe":
            return await self.subscribe_events(arguments)
        if name == "_event_bridge_unsubscribe":
            return await self.unsubscribe_events(arguments)
        if self.selected_tools is not None and name not in self.selected_tools:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"Tool '{name}' is not enabled")],
                isError=True,
            )

        context = self.server.request_context
        meta = context.meta.model_dump(by_alias=True, exclude_none=True) if context.meta else None
        progress_token = context.meta.progressToken if context.meta else None

        async def progress(progress: float, total: float | None, message: str | None) -> None:
            if progress_token is not None:
                await context.session.send_progress_notification(progress_token, progress, total, message)

        # ponytail: MCP 1.28.1 hides outgoing request IDs; use the released
        # cancel_on_abandon API instead of private internals when available.
        return await self._remote().call_tool(
            name,
            arguments,
            progress_callback=progress if progress_token is not None else None,
            meta=meta,
        )

    async def subscribe_events(self, arguments: dict[str, Any]) -> types.CallToolResult:
        event = arguments.get("event")
        inbox_id = arguments.get("inboxId")
        if not isinstance(event, str) or (inbox_id is not None and not isinstance(inbox_id, str)):
            return types.CallToolResult(
                content=[types.TextContent(type="text", text="event is required and inboxId must be a string")], isError=True
            )
        key = (event, (inbox_id,) if inbox_id else ())
        self.event_subscriptions[key] = self.event_subscriptions.get(key, 0) + 1
        if self.event_task is None:
            self.event_task = asyncio.create_task(self.listen_for_events())
        return types.CallToolResult(content=[types.TextContent(type="text", text="subscribed")])

    async def unsubscribe_events(self, arguments: dict[str, Any]) -> types.CallToolResult:
        event = arguments.get("event")
        inbox_id = arguments.get("inboxId")
        key = (event, (inbox_id,) if isinstance(inbox_id, str) else ())
        if key in self.event_subscriptions:
            self.event_subscriptions[key] -= 1
            if self.event_subscriptions[key] <= 0:
                self.event_subscriptions.pop(key)
        if not self.event_subscriptions and self.event_task is not None:
            self.event_task.cancel()
            self.event_task = None
        return types.CallToolResult(content=[types.TextContent(type="text", text="unsubscribed")])

    async def listen_for_events(self) -> None:
        """Maintain an outbound AgentMail WebSocket and emit reference-only events."""
        assert self.api_key is not None
        while self.event_subscriptions:
            try:
                client = AsyncAgentMail(api_key=self.api_key)
                async with client.websockets.connect() as socket:
                    event_types = sorted({event for event, _ in self.event_subscriptions})
                    inbox_ids = sorted({inbox for _, inboxes in self.event_subscriptions for inbox in inboxes})
                    # AgentMail's WebSocket endpoint requires an inbox or pod
                    # filter.  An omitted local filter means every inbox the
                    # configured API key can list, not a cloud-to-local wildcard.
                    if not inbox_ids:
                        inboxes = await client.inboxes.list(limit=100)
                        inbox_ids = sorted(inbox.inbox_id for inbox in inboxes.inboxes)
                    if not inbox_ids:
                        raise RuntimeError("No AgentMail inboxes are available for the event subscription")
                    await socket.send_subscribe(Subscribe(event_types=event_types, inbox_ids=inbox_ids))
                    print(
                        f"agentmail-mcp: event WebSocket subscribed to {', '.join(event_types)}"
                        + f" for {', '.join(inbox_ids)}",
                        file=sys.stderr,
                    )
                    async for event in socket:
                        event_detail = (
                            f"{getattr(event, 'name', '')}: {getattr(event, 'message', '')}"
                            if type(event).__name__ == "Error"
                            else None
                        )
                        print(
                            "agentmail-mcp: event WebSocket received "
                            f"{getattr(event, 'event_type', type(event).__name__)}"
                            + (f": {event_detail}" if event_detail else ""),
                            file=sys.stderr,
                        )
                        await self.forward_event(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                print("agentmail-mcp: event WebSocket failed; reconnecting", file=sys.stderr)
                await asyncio.sleep(5)

    async def forward_event(self, event: Any) -> None:
        if self.local_session is None:
            return
        event_name = getattr(event, "event_type", None)
        message = getattr(event, "message", None)
        inbox_id = getattr(message, "inbox_id", None)
        message_id = getattr(message, "message_id", None)
        if not isinstance(event_name, str) or not isinstance(inbox_id, str) or not isinstance(message_id, str):
            return
        if (event_name, (inbox_id,)) not in self.event_subscriptions and (event_name, ()) not in self.event_subscriptions:
            return
        await self.local_session.send_notification(  # type: ignore[arg-type]
            EventBridgeNotification(
                params={
                    "eventId": getattr(event, "event_id", message_id),
                    "source": "agentmail",
                    "event": event_name,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "data": {"inboxId": inbox_id, "messageId": message_id},
                }
            )
        )

    async def remote_message(self, message: Any) -> None:
        if (
            isinstance(message, types.ServerNotification)
            and isinstance(message.root, types.ToolListChangedNotification)
            and self.local_session is not None
        ):
            await self.local_session.send_tool_list_changed()

    def _remote(self) -> ClientSession:
        if self.remote is None:
            raise RuntimeError("Hosted MCP session is not connected")
        return self.remote


def parse_args(argv: list[str] | None = None) -> tuple[str, frozenset[str] | None]:
    parser = argparse.ArgumentParser(description="AgentMail hosted MCP stdio bridge")
    parser.add_argument("--api-key", help="Legacy alternative to AGENTMAIL_API_KEY")
    parser.add_argument("--tools", help="Comma-separated remote tool names to expose")
    args = parser.parse_args(argv)
    api_key = args.api_key or os.environ.get("AGENTMAIL_API_KEY")
    if not api_key:
        parser.error("AGENTMAIL_API_KEY or --api-key is required")
    selected = None
    if args.tools is not None:
        selected = frozenset(name.strip() for name in args.tools.split(",") if name.strip())
        if not selected:
            parser.error("--tools requires at least one tool name")
    return api_key, selected


async def run(api_key: str, selected_tools: frozenset[str] | None = None) -> None:
    bridge = Bridge(selected_tools)
    bridge.api_key = api_key
    headers = {
        "x-api-key": api_key,
        "User-Agent": f"agentmail-mcp-python/{VERSION}",
        "X-AgentMail-MCP-Bridge": f"python/{VERSION}",
    }
    async with httpx.AsyncClient(headers=headers, follow_redirects=False) as http:
        async with streamable_http_client(ENDPOINT, http_client=http) as (read, write, _):
            async with ClientSession(
                read,
                write,
                message_handler=bridge.remote_message,
                client_info=types.Implementation(name="agentmail-mcp-python", version=VERSION),
            ) as remote:
                bridge.remote = remote
                await remote.initialize()
                async with mcp.server.stdio.stdio_server() as (local_read, local_write):
                    await bridge.server.run(
                        local_read,
                        local_write,
                        InitializationOptions(
                            server_name="agentmail-mcp",
                            server_version=VERSION,
                            capabilities=bridge.server.get_capabilities(
                                notification_options=NotificationOptions(tools_changed=True),
                                experimental_capabilities={},
                            ),
                        ),
                    )


def main() -> None:
    api_key, selected_tools = parse_args()
    try:
        anyio.run(run, api_key, selected_tools)
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"agentmail-mcp: hosted bridge failed ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
