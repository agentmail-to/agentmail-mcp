# Third-party correction queue

Use this request text where a direct source change is unavailable:

> AgentMail now has one canonical hosted MCP implementation at https://mcp.agentmail.to/mcp, sourced from https://github.com/agentmail-to/agentmail-mcp. Please make hosted Streamable HTTP the primary setup, label npm and PyPI as stdio compatibility bridges, remove fixed tool counts, and remove links to the former Manufact or Smithery implementations. Tool metadata should come from the runtime-generated mcp-manifest.json.

| Surface | Observed July 13, 2026 | Prepared action |
| --- | --- | --- |
| Google ADK | Documents the npm stdio process and an old subset of tools. | Submit a source PR at https://github.com/google/adk-docs/edit/main/docs/integrations/agentmail.md using hosted `StreamableHTTPConnectionParams`; link the runtime contract. |
| NousResearch Hermes | Requires Node, launches npm locally, and claims 11 tools. | Submit a PR for https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/email/agentmail/SKILL.md using Hermes remote HTTP configuration if supported; otherwise label npm as the bridge and remove the count. |
| PulseMCP | Current official page resolves to `to.agentmail/agentmail` and the canonical endpoint. | Recheck after Registry publication; no correction currently required. |
| Glama | Marks the legacy Smithery connector unhealthy, links the old repository, and reports 11 tools. | Email `support@glama.ai` with the request above or claim the canonical connector through Glama's documented ownership flow. |
| Drio | Publishes the dead Smithery Registry endpoint and old repository with zero tools. | Use https://www.getdrio.com/contact and request reindexing from `to.agentmail/agentmail`. |
| Playbooks | Mirrors the first-party AgentMail skill. | Recheck after the `agentmail-skills` source commit is published; request cache refresh if it does not update. |
| ColdIQ | Teaches the npm process as the implementation and uses a nonexistent `get_message` filter example. | Use https://coldiq.com/contact and request hosted-first copy plus current dynamic tool discovery. |
| Awesome Claude | Lists `npx -y agentmail-mcp` as the primary install. | Submit a correction at https://github.com/webfuse-com/awesome-claude/issues/new or through its pull-request workflow. |
| NeverSight / AgentSkills | Page timed out during the audit. | Recheck the page and request a source refresh if it still mirrors old package or count claims. |
| ClawHub | The audited slug redirects without exposing usable skill content. | Use the ClawHub publisher flow to supersede or remove the stale listing after canonical skills are published. |
| EliteAI | Mirrors the Hermes skill, including the npm requirement and 11-tool claim. | Fix Hermes upstream first, then request or wait for a mirror refresh. |
| Skillopedia, MCP Market, MCPBar, Metorial, TensorBlock, other mirrors | Discovery source or update path was not reliably identifiable. | Search after Registry cutover; request a reindex to `to.agentmail/agentmail` or record the page as immutable/unresponsive. |

Do not submit these requests until the canonical server and bridge releases are live. Record the resulting PR, issue, email, or immutable-history evidence in `migration-surfaces.yaml`.
