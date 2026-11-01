# Changelog

## 0.2.0

- **Floating chat on every page of Zabbix**, with a button in the corner and three sizes: minimized, normal and wide. `Ctrl+.` opens or closes it, and `Esc` makes it smaller.
- **It stays open when you change page, section or module**: size, chat, draft and scroll are kept. An answer in progress goes on in the next page from the last saved step. A change that was being applied is never sent twice.
- **Several tabs**: one runs the agent and the others follow it live, in read only, and can stop it. If that tab closes, another one goes on.
- New look: warm, neutral colors, bubbles for your messages, serif text for the answers, a rounded box to write in and folded tools. Follows the light and dark themes of Zabbix.
- New action `agent.config`, which gives the floating chat its configuration.

## 0.1.0

First version.

- Chat in **Monitoring → AI agent**, connected to the native Zabbix MCP server with the session of each user.
- OpenAI-compatible and Anthropic-compatible (Claude) providers, with encrypted keys.
- Streaming, visible tool calls, approval of changes enforced on the server, plan, ask and auto modes, task list, questions to the user, stop, summary of the context and slash commands.
- English and Spanish.
