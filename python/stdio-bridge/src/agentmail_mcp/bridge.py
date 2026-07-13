import argparse
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

ENDPOINT = "https://mcp.agentmail.to/mcp"
VERSION = version("agentmail-mcp")


class Bridge:
    def __init__(self, selected_tools: frozenset[str] | None = None) -> None:
        self.selected_tools = selected_tools
        self.remote: ClientSession | None = None
        self.local_session: Any = None
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

        return await self._remote().call_tool(
            name,
            arguments,
            progress_callback=progress if progress_token is not None else None,
            meta=meta,
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
