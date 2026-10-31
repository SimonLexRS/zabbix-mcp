/*
 * AI agent: the chat of the module. The browser drives the agent: it asks the server for one turn of the model, runs the
 * tools that turn requests, asks the user to approve changes, and goes on until the model stops calling tools.
 */
(function () {
	'use strict';

	const MODES = ['ask', 'plan', 'auto'];
	const SESSIONS_KEPT = 30;

	const LOCAL_TOOLS = [
		{
			name: 'todo_write',
			description: 'Show the user the task list of the current work. Send the whole list each time, with one task in_progress at most.',
			inputSchema: {
				type: 'object',
				properties: {
					todos: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								content: {type: 'string'},
								status: {type: 'string', enum: ['pending', 'in_progress', 'completed']}
							},
							required: ['content', 'status']
						}
					}
				},
				required: ['todos']
			}
		},
		{
			name: 'ask_user',
			description: 'Ask the user a question and wait for the answer, when a decision is needed to continue.',
			inputSchema: {
				type: 'object',
				properties: {question: {type: 'string'}},
				required: ['question']
			}
		}
	];

	let lang = {};
	const t = (text) => lang[text] || text;

	function el(tag, className, text) {
		const node = document.createElement(tag);

		if (className) {
			node.className = className;
		}

		if (text !== undefined) {
			node.textContent = text;
		}

		return node;
	}

	function post(action, token, csrfName, payload, signal) {
		const body = new URLSearchParams();

		body.set(csrfName, token);
		body.set('payload', JSON.stringify(payload));

		return fetch('zabbix.php?action=' + action, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body,
			signal
		});
	}

	/* Markdown: everything is escaped first, so only the markup added here reaches the page. */

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
	}

	function inline(text) {
		return text
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
	}

	function markdown(source) {
		const lines = escapeHtml(source).split('\n');
		const html = [];
		let list = null;

		const closeList = () => {
			if (list) {
				html.push('</' + list + '>');
				list = null;
			}
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let m;

			if (line.startsWith('```')) {
				closeList();
				const code = [];

				for (i++; i < lines.length && !lines[i].startsWith('```'); i++) {
					code.push(lines[i]);
				}

				html.push('<pre><code>' + code.join('\n') + '</code></pre>');
			}
			else if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
				closeList();
				const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
				const rows = ['<div class="zbxagent-table"><table><thead><tr>'
					+ cells(line).map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'];

				for (i += 2; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) {
					rows.push('<tr>' + cells(lines[i]).map((c) => '<td>' + c + '</td>').join('') + '</tr>');
				}

				i--;
				html.push(rows.join('') + '</tbody></table></div>');
			}
			else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
				closeList();
				html.push('<h' + (m[1].length + 2) + '>' + inline(m[2]) + '</h' + (m[1].length + 2) + '>');
			}
			else if ((m = line.match(/^\s*[-*]\s+(.*)/)) || (m = line.match(/^\s*\d+\.\s+(.*)/))) {
				const kind = /^\s*\d+\./.test(line) ? 'ol' : 'ul';

				if (list !== kind) {
					closeList();
					list = kind;
					html.push('<' + kind + '>');
				}

				html.push('<li>' + inline(m[1]) + '</li>');
			}
			else if (line.trim() === '') {
				closeList();
			}
			else {
				closeList();
				html.push('<p>' + inline(line) + '</p>');
			}
		}

		closeList();

		return html.join('');
	}

	/* Conversations are kept in this browser, per Zabbix user. */

	class Store {
		constructor(userid) {
			this.key = 'zbxagent.' + userid + '.sessions';
		}

		load() {
			try {
				return JSON.parse(localStorage.getItem(this.key)) || [];
			}
			catch (e) {
				return [];
			}
		}

		save(sessions) {
			let kept = sessions.slice(0, SESSIONS_KEPT);

			while (kept.length > 0) {
				try {
					localStorage.setItem(this.key, JSON.stringify(kept));
					return;
				}
				catch (e) {
					kept = kept.slice(0, -1);
				}
			}
		}

		clear() {
			try {
				localStorage.removeItem(this.key);
			}
			catch (e) {
				// Nothing to clear.
			}
		}
	}

	class Agent {
		constructor(root, config) {
			this.root = root;
			this.config = config;
			this.store = new Store(config.userid);
			this.sessions = this.store.load();
			this.session = null;
			this.tools = [];
			this.running = false;
			this.abort = null;
			this.pending = null;
			this.mode = 'ask';
			this.provider = config.default_provider;

			this.build();
			this.newSession();
			this.loadTools();
		}

		call(action, token, payload, signal) {
			return post(action, token, this.config.csrf_name, payload, signal);
		}

		/* Interface */

		build() {
			const bar = el('div', 'zbxagent-bar');

			this.providerSelect = el('select');
			this.config.providers.forEach((p) => {
				const option = el('option', '', p.name + ' · ' + p.model);

				option.value = p.id;
				option.selected = p.id === this.provider;
				this.providerSelect.append(option);
			});
			this.providerSelect.addEventListener('change', () => { this.provider = this.providerSelect.value; });

			this.sessionSelect = el('select');
			this.sessionSelect.addEventListener('change', () => this.openSession(this.sessionSelect.value));

			const newButton = el('button', 'btn-alt', t('New chat'));
			newButton.type = 'button';
			newButton.addEventListener('click', () => this.newSession());

			this.usageLabel = el('span', 'zbxagent-usage');

			bar.append(this.sessionSelect, newButton, this.providerSelect, this.usageLabel);

			this.todosBox = el('div', 'zbxagent-todos');
			this.todosBox.hidden = true;

			this.log = el('div', 'zbxagent-log');
			this.log.setAttribute('role', 'log');
			this.log.setAttribute('aria-live', 'polite');

			this.palette = el('div', 'zbxagent-palette');
			this.palette.hidden = true;

			this.input = el('textarea', 'zbxagent-input');
			this.input.rows = 2;
			this.input.placeholder = t('Ask about your monitoring, or type / for commands');
			this.input.setAttribute('aria-label', t('Message'));
			this.input.addEventListener('keydown', (e) => this.onKey(e));
			this.input.addEventListener('input', () => this.updatePalette());

			this.sendButton = el('button', 'zbxagent-send', t('Send'));
			this.sendButton.type = 'button';
			this.sendButton.addEventListener('click', () => this.running ? this.stop() : this.submit());

			const row = el('div', 'zbxagent-compose');
			row.append(this.input, this.sendButton);

			this.modeButton = el('button', 'zbxagent-mode');
			this.modeButton.type = 'button';
			this.modeButton.addEventListener('click', () => this.cycleMode());

			this.hint = el('span', 'zbxagent-hint', t('Shift+Tab changes the mode · Enter sends · Shift+Enter adds a line'));

			const foot = el('div', 'zbxagent-foot');
			foot.append(this.modeButton, this.hint);

			const notice = el('div', 'zbxagent-notice',
				t('What the tools return, including values and internal addresses, is sent to the selected provider.'));

			this.root.append(bar, notice, this.todosBox, this.log, this.palette, row, foot);
			this.updateMode();

			if (this.config.providers.length === 0) {
				this.system(this.config.is_admin
					? t('There are no providers yet: add one in Settings.')
					: t('There are no providers yet: ask an administrator to add one.'));
			}
		}

		refreshSessions() {
			this.sessionSelect.textContent = '';

			[this.session].concat(this.sessions.filter((s) => s.id !== this.session.id)).forEach((s) => {
				const option = el('option', '', s.title || t('New chat'));

				option.value = s.id;
				this.sessionSelect.append(option);
			});

			this.sessionSelect.value = this.session.id;
		}

		newSession() {
			if (this.running) {
				return;
			}

			this.session = {
				id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
				title: '',
				messages: [],
				todos: [],
				allowed: [],
				usage: {input: 0, output: 0, last: 0}
			};
			this.renderSession();
		}

		openSession(id) {
			const session = this.sessions.find((s) => s.id === id);

			if (session && !this.running) {
				this.session = session;
				this.renderSession();
			}
		}

		persist() {
			if (this.session.messages.length === 0) {
				return;
			}

			this.sessions = [this.session].concat(this.sessions.filter((s) => s.id !== this.session.id));
			this.store.save(this.sessions);
			this.refreshSessions();
		}

		renderSession() {
			this.log.textContent = '';
			this.toolBlocks = {};
			this.renderTodos();
			this.renderUsage();
			this.refreshSessions();

			this.session.messages.forEach((m) => {
				if (m.role === 'user') {
					this.addUser(m.display || m.content);
				}
				else if (m.role === 'assistant') {
					if (m.reasoning) {
						this.addReasoning().body.textContent = m.reasoning;
					}

					if (m.content) {
						this.addAssistant().innerHTML = markdown(m.content);
					}

					(m.tool_calls || []).forEach((call) => this.addTool(call));
				}
				else if (m.role === 'tool' && this.toolBlocks[m.tool_call_id]) {
					this.finishTool(this.toolBlocks[m.tool_call_id], m.content, m.is_error, m.ms);
				}
			});

			if (this.session.messages.length === 0 && this.config.providers.length > 0) {
				this.log.append(this.welcome());
			}

			this.scroll();
		}

		welcome() {
			const box = el('div', 'zbxagent-welcome');

			box.append(el('strong', '', t('What do you want to look at?')));

			[
				t('Which problems are active, and what do they have in common?'),
				t('Which hosts are unavailable, and since when?'),
				t('Review the maintenance periods and tell me which ones are active.')
			].forEach((question) => {
				const button = el('button', '', question);

				button.type = 'button';
				button.addEventListener('click', () => {
					this.input.value = question;
					this.submit();
				});
				box.append(button);
			});

			return box;
		}

		scroll() {
			this.log.scrollTop = this.log.scrollHeight;
		}

		system(text, kind) {
			const node = el('div', 'zbxagent-system' + (kind ? ' ' + kind : ''), text);

			this.log.append(node);
			this.scroll();

			return node;
		}

		addUser(text) {
			const node = el('div', 'zbxagent-user', text);

			this.log.append(node);
			this.scroll();
		}

		addAssistant() {
			const node = el('div', 'zbxagent-assistant');

			this.log.append(node);

			return node;
		}

		addReasoning() {
			const details = el('details', 'zbxagent-reasoning');
			const body = el('div');

			details.append(el('summary', '', t('Reasoning')), body);
			this.log.append(details);

			return {details, body};
		}

		addTool(call) {
			const details = el('details', 'zbxagent-tool');
			const summary = el('summary');
			const state = el('span', 'zbxagent-tool-state', '●');
			const name = el('span', 'zbxagent-tool-name', call.name);
			const brief = el('span', 'zbxagent-tool-brief', this.brief(call.arguments));
			const time = el('span', 'zbxagent-tool-time');
			const args = el('pre', '', JSON.stringify(call.arguments || {}, null, 2));
			const result = el('pre', 'zbxagent-tool-result');

			summary.append(state, name, brief, time);
			details.append(summary, el('div', 'zbxagent-label', t('Parameters')), args, result);
			this.log.append(details);

			const block = {details, state, time, result};

			this.toolBlocks[call.id] = block;
			this.scroll();

			return block;
		}

		finishTool(block, text, isError, ms) {
			block.state.className = 'zbxagent-tool-state ' + (isError ? 'is-error' : 'is-ok');
			block.time.textContent = ms ? ms + ' ms' : '';
			block.result.textContent = this.pretty(text);
		}

		brief(args) {
			const text = JSON.stringify(args || {});

			return text === '{}' ? '' : (text.length > 90 ? text.slice(0, 90) + '…' : text);
		}

		pretty(text) {
			try {
				return JSON.stringify(JSON.parse(text), null, 2);
			}
			catch (e) {
				return text;
			}
		}

		renderTodos() {
			const todos = this.session.todos;

			this.todosBox.textContent = '';
			this.todosBox.hidden = todos.length === 0;

			todos.forEach((todo) => {
				const mark = {completed: '✓', in_progress: '▸'}[todo.status] || '○';

				this.todosBox.append(el('div', 'zbxagent-todo is-' + todo.status, mark + ' ' + todo.content));
			});
		}

		renderUsage() {
			const u = this.session.usage;

			this.usageLabel.textContent = t('Tokens') + ': ' + u.input.toLocaleString() + ' ↑ '
				+ u.output.toLocaleString() + ' ↓';
		}

		updateMode() {
			this.modeButton.textContent = t('Mode') + ': ' + {
				ask: t('Ask before changes'),
				plan: t('Plan (read only)'),
				auto: t('Auto (applies changes)')
			}[this.mode];
			this.modeButton.className = 'zbxagent-mode is-' + this.mode;
		}

		cycleMode() {
			this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
			this.updateMode();
		}

		setRunning(running) {
			this.running = running;
			this.sendButton.textContent = running ? t('Stop') : t('Send');
			this.sendButton.classList.toggle('is-stop', running);
			this.providerSelect.disabled = running;
			this.sessionSelect.disabled = running;
		}

		/* Input */

		onKey(e) {
			if (e.key === 'Tab' && e.shiftKey) {
				e.preventDefault();
				this.cycleMode();
			}
			else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();

				if (!this.running) {
					this.submit();
				}
			}
			else if (e.key === 'Escape' && this.running) {
				this.stop();
			}
		}

		commands() {
			return [
				['/help', t('Show the commands')],
				['/clear', t('Start a new chat')],
				['/compact', t('Summarize the conversation to free context')],
				['/mode', t('Change the mode: ask, plan or auto')],
				['/model', t('Show or change the provider')],
				['/tools', t('List the tools of the MCP server')],
				['/sessions', t('List the saved chats')],
				['/forget', t('Delete the chats saved in this browser')]
			];
		}

		updatePalette() {
			const text = this.input.value;

			this.palette.textContent = '';

			if (!text.startsWith('/') || text.includes(' ')) {
				this.palette.hidden = true;
				return;
			}

			const matches = this.commands().filter(([name]) => name.startsWith(text));

			this.palette.hidden = matches.length === 0;
			matches.forEach(([name, description]) => {
				const item = el('button', 'zbxagent-palette-item');

				item.type = 'button';
				item.append(el('strong', '', name), el('span', '', description));
				item.addEventListener('click', () => {
					this.input.value = name + ' ';
					this.palette.hidden = true;
					this.input.focus();
				});
				this.palette.append(item);
			});
		}

		submit() {
			const text = this.input.value.trim();

			if (text === '') {
				return;
			}

			this.input.value = '';
			this.palette.hidden = true;

			if (text.startsWith('/')) {
				this.command(text);
				return;
			}

			if (!this.provider) {
				this.system(t('There are no providers yet: add one in Settings.'), 'is-error');
				return;
			}

			if (!this.session.title) {
				this.session.title = text.slice(0, 50);
			}

			this.log.querySelector('.zbxagent-welcome')?.remove();
			this.session.messages.push({role: 'user', content: text});
			this.addUser(text);
			this.persist();
			this.run();
		}

		command(text) {
			const [name, ...rest] = text.split(/\s+/);
			const arg = rest.join(' ');

			switch (name) {
				case '/help':
					this.system(this.commands().map(([n, d]) => n + ' — ' + d).join('\n'));
					break;

				case '/clear':
					this.newSession();
					break;

				case '/compact':
					this.compact();
					break;

				case '/mode':
					if (MODES.includes(arg)) {
						this.mode = arg;
						this.updateMode();
					}
					else {
						this.system(t('Modes') + ': ' + MODES.join(', '));
					}
					break;

				case '/model': {
					const found = this.config.providers.find((p) => p.id === arg || p.name === arg);

					if (found) {
						this.provider = found.id;
						this.providerSelect.value = found.id;
					}

					this.system(this.config.providers.map((p) =>
						(p.id === this.provider ? '● ' : '○ ') + p.id + ' — ' + p.name + ' · ' + p.model
					).join('\n'));
					break;
				}

				case '/tools':
					this.system(this.tools.map((tool) =>
						(tool.read_only ? '○ ' : '✎ ') + tool.name + ' — ' + tool.title
					).join('\n') || t('No tools available.'));
					break;

				case '/sessions':
					this.system(this.sessions.map((s) => '• ' + s.title).join('\n') || t('No saved chats.'));
					break;

				case '/forget':
					this.store.clear();
					this.sessions = [];
					this.newSession();
					this.system(t('The chats saved in this browser were deleted.'));
					break;

				default:
					this.system(t('Unknown command. Type /help.'), 'is-error');
			}
		}

		stop() {
			if (this.abort) {
				this.abort.abort();
			}

			if (this.pending) {
				this.pending(null);
			}
		}

		/* The agent */

		async loadTools() {
			try {
				const response = await this.call('agent.tools', this.config.tokens.tools, {});
				const data = await response.json();

				if (data.error) {
					this.system(t('Cannot use the MCP server') + ': ' + data.error, 'is-error');
				}
				else {
					this.tools = data.tools;
				}
			}
			catch (e) {
				this.system(t('Cannot use the MCP server') + ': ' + e.message, 'is-error');
			}
		}

		async run() {
			this.setRunning(true);
			this.abort = new AbortController();

			try {
				for (let step = 0; ; step++) {
					if (step >= this.config.max_steps) {
						this.system(t('The agent reached the limit of steps. Say "continue" to go on.'), 'is-warning');
						break;
					}

					if (this.session.usage.last > this.config.context_tokens * 0.8) {
						await this.compact(true);
					}

					const turn = await this.turn();

					if (!turn) {
						break;
					}

					const calls = turn.message.tool_calls || [];

					if (calls.length === 0) {
						break;
					}

					await this.runTools(calls);

					if (this.abort.signal.aborted) {
						break;
					}
				}
			}
			catch (e) {
				if (e.name !== 'AbortError') {
					this.system(e.message, 'is-error');
				}
			}

			if (this.abort.signal.aborted) {
				this.system(t('Stopped.'));
			}

			this.closeOpenCalls();
			this.setRunning(false);
			this.persist();
			this.input.focus();
		}

		/* Every tool call needs a result, or the provider rejects the next request. */
		closeOpenCalls() {
			const answered = new Set(this.session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));

			this.session.messages.slice().forEach((m) => {
				(m.tool_calls || []).forEach((call) => {
					if (!answered.has(call.id)) {
						this.addResult(call, t('Cancelled by the user.'), true, 0);
					}
				});
			});
		}

		addResult(call, text, isError, ms) {
			this.session.messages.push({
				role: 'tool', tool_call_id: call.id, name: call.name, content: text, is_error: isError, ms
			});

			if (this.toolBlocks[call.id]) {
				this.finishTool(this.toolBlocks[call.id], text, isError, ms);
			}
		}

		apiMessages() {
			return this.session.messages.map((m) => {
				const {display, ms, ...rest} = m;

				return rest;
			});
		}

		async turn() {
			const response = await this.call('agent.chat', this.config.tokens.chat, {
				provider: this.provider,
				mode: this.mode,
				messages: this.apiMessages(),
				local_tools: LOCAL_TOOLS
			}, this.abort.signal);

			if (!response.ok) {
				throw new Error('HTTP ' + response.status);
			}

			let text = '';
			let node = null;
			let reasoning = null;
			let result = null;
			let error = null;

			await this.readEvents(response, (type, value) => {
				if (type === 'text') {
					text += value;
					node = node || this.addAssistant();
					node.innerHTML = markdown(text);
					this.scroll();
				}
				else if (type === 'reasoning') {
					reasoning = reasoning || this.addReasoning();
					reasoning.body.textContent += value;
				}
				else if (type === 'done') {
					result = value;
				}
				else if (type === 'error') {
					error = value;
				}
			});

			if (error !== null) {
				throw new Error(error);
			}

			if (!result) {
				throw new Error(t('The provider closed the connection without a response.'));
			}

			this.session.messages.push(result.message);
			this.session.usage.input += result.usage.input;
			this.session.usage.output += result.usage.output;
			this.session.usage.last = result.usage.input;
			this.renderUsage();
			this.persist();

			if (result.stop === 'length' || result.stop === 'max_tokens') {
				this.system(t('The response was cut by the limit of output tokens of this provider.'), 'is-warning');
			}

			return result;
		}

		async readEvents(response, handler) {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			for (;;) {
				const {done, value} = await reader.read();

				if (done) {
					break;
				}

				buffer += decoder.decode(value, {stream: true});

				let end;

				while ((end = buffer.indexOf('\n\n')) !== -1) {
					const chunk = buffer.slice(0, end);

					buffer = buffer.slice(end + 2);

					if (chunk.startsWith('data: ')) {
						const event = JSON.parse(chunk.slice(6));

						handler(event.t, event.v);
					}
				}
			}
		}

		async runTools(calls) {
			for (const call of calls) {
				if (this.abort.signal.aborted) {
					return;
				}

				const block = this.addTool(call);

				if (call.name === 'todo_write') {
					this.session.todos = Array.isArray(call.arguments.todos) ? call.arguments.todos : [];
					this.renderTodos();
					this.addResult(call, 'The task list was updated.', false, 0);
				}
				else if (call.name === 'ask_user') {
					const answer = await this.ask(String(call.arguments.question || ''));

					if (answer === null) {
						return;
					}

					this.addResult(call, answer, false, 0);
				}
				else {
					await this.runMcpTool(call, block);
				}

				this.persist();
			}
		}

		async runMcpTool(call) {
			const tool = this.tools.find((candidate) => candidate.name === call.name);
			const readOnly = tool ? tool.read_only : false;
			let approved = readOnly;

			if (!readOnly) {
				if (this.mode === 'plan') {
					this.addResult(call, 'Plan mode only allows read tools: propose this change instead.', true, 0);
					return;
				}

				approved = this.mode === 'auto' || this.session.allowed.includes(call.name);

				if (!approved) {
					const decision = await this.approve(call, tool);

					if (decision === null) {
						return;
					}

					if (decision === 'session') {
						this.session.allowed.push(call.name);
					}

					approved = decision !== 'reject';
				}

				if (!approved) {
					this.addResult(call, 'The user rejected this change. Nothing was changed.', true, 0);
					return;
				}
			}

			const response = await this.call('agent.tool', this.config.tokens.tool, {
				name: call.name,
				arguments: call.arguments,
				mode: this.mode,
				approved: approved && !readOnly
			}, this.abort.signal);
			const data = await response.json();

			this.addResult(call, data.text, data.is_error, data.ms);
		}

		approve(call, tool) {
			return new Promise((resolve) => {
				const card = el('div', 'zbxagent-card zbxagent-approval');

				card.append(
					el('div', 'zbxagent-card-title', (tool && tool.destructive ? '⚠ ' : '') + t('The agent wants to make a change')),
					el('div', 'zbxagent-card-tool', (tool ? tool.title + ' · ' : '') + call.name),
					el('pre', '', JSON.stringify(call.arguments || {}, null, 2))
				);

				const actions = el('div', 'zbxagent-card-actions');

				const finish = (decision, label) => {
					this.pending = null;
					actions.replaceWith(el('div', 'zbxagent-card-result', label));
					resolve(decision);
				};

				[['once', t('Allow'), ''], ['session', t('Allow in this chat'), 'btn-alt'], ['reject', t('Reject'), 'btn-alt']]
					.forEach(([decision, label, className]) => {
						const button = el('button', className, label);

						button.type = 'button';
						button.addEventListener('click', () => finish(decision, label));
						actions.append(button);
					});

				card.append(actions);
				this.log.append(card);
				this.pending = (value) => finish(value, t('Stopped.'));
				this.scroll();
			});
		}

		ask(question) {
			return new Promise((resolve) => {
				const card = el('div', 'zbxagent-card');
				const input = el('input');
				const send = el('button', '', t('Answer'));

				input.type = 'text';
				input.setAttribute('aria-label', t('Answer'));
				send.type = 'button';

				const actions = el('div', 'zbxagent-card-actions');

				const finish = (value) => {
					this.pending = null;
					actions.replaceWith(el('div', 'zbxagent-card-result', value === null ? t('Stopped.') : value));
					resolve(value);
				};

				send.addEventListener('click', () => finish(input.value));
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						finish(input.value);
					}
				});

				actions.append(input, send);
				card.append(el('div', 'zbxagent-card-title', question), actions);
				this.log.append(card);
				this.pending = finish;
				input.focus();
				this.scroll();
			});
		}

		async compact(inside) {
			if (this.session.messages.length === 0) {
				return;
			}

			if (!inside) {
				this.setRunning(true);
				this.abort = new AbortController();
			}

			const note = this.system(t('Summarizing the conversation…'));

			try {
				const response = await this.call('agent.chat', this.config.tokens.chat, {
					provider: this.provider,
					mode: this.mode,
					purpose: 'summary',
					messages: this.apiMessages().concat([{role: 'user', content: 'Summarize the conversation now.'}])
				}, this.abort.signal);

				let result = null;
				let error = null;

				await this.readEvents(response, (type, value) => {
					if (type === 'done') {
						result = value;
					}
					else if (type === 'error') {
						error = value;
					}
				});

				if (error !== null || !result) {
					throw new Error(error || t('The provider closed the connection without a response.'));
				}

				this.session.messages = [{
					role: 'user',
					content: 'Summary of the conversation so far:\n\n' + result.message.content
				}];
				this.session.usage.last = 0;
				note.textContent = t('Conversation summarized.');
				this.persist();
			}
			catch (e) {
				note.textContent = e.message;
				note.classList.add('is-error');
			}

			if (!inside) {
				this.setRunning(false);
			}
		}
	}

	/* Settings page */

	class SettingsForm {
		constructor(root, config) {
			this.root = root;
			this.config = config;
			this.settings = config.settings;
			this.render();
		}

		field(label, input, help) {
			const wrap = el('label', 'zbxagent-field');

			wrap.append(el('span', 'zbxagent-field-label', label), input);

			if (help) {
				wrap.append(el('span', 'zbxagent-field-help', help));
			}

			return wrap;
		}

		text(value, type) {
			const input = el('input');

			input.type = type || 'text';
			input.value = value === undefined ? '' : value;
			input.autocomplete = 'off';

			return input;
		}

		render() {
			this.root.textContent = '';

			const s = this.settings;

			this.mcpUrl = this.text(s.mcp_url);
			this.maxSteps = this.text(s.max_steps, 'number');
			this.contextTokens = this.text(s.context_tokens, 'number');
			this.instructions = el('textarea');
			this.instructions.rows = 4;
			this.instructions.value = s.instructions;

			const general = el('div', 'zbxagent-settings-box');

			general.append(
				el('h4', '', t('Connection')),
				this.field(t('MCP server URL'), this.mcpUrl, t('Each user connects with their own Zabbix session, so permissions and the audit log are theirs.')),
				this.field(t('Maximum steps per request'), this.maxSteps),
				this.field(t('Summarize the conversation at these tokens'), this.contextTokens),
				this.field(t('Instructions for the agent'), this.instructions, t('Added to the system prompt for every user.'))
			);

			this.list = el('div');
			(s.providers.length ? s.providers : []).forEach((p) => this.addProvider(p));

			const add = el('button', 'btn-alt', t('Add provider'));
			add.type = 'button';
			add.addEventListener('click', () => this.addProvider({
				id: 'provider-' + Date.now().toString(36), type: 'openai', max_tokens: 4096
			}));

			const providers = el('div', 'zbxagent-settings-box');
			providers.append(el('h4', '', t('Providers')), this.list, add);

			const save = el('button', '', t('Save'));
			save.type = 'button';
			save.addEventListener('click', () => this.save());
			this.status = el('span', 'zbxagent-status');
			this.status.setAttribute('role', 'status');

			const actions = el('div', 'zbxagent-settings-actions');
			actions.append(save, this.status);

			this.root.append(general, providers, actions);
		}

		addProvider(p) {
			const row = el('div', 'zbxagent-provider');
			const name = this.text(p.name);
			const type = el('select');

			[['openai', t('OpenAI-compatible')], ['anthropic', t('Anthropic-compatible (Claude)')]].forEach(([value, label]) => {
				const option = el('option', '', label);

				option.value = value;
				option.selected = p.type === value;
				type.append(option);
			});

			const baseUrl = this.text(p.base_url);
			const model = this.text(p.model);
			const maxTokens = this.text(p.max_tokens || 4096, 'number');
			const key = this.text('', 'password');
			key.placeholder = p.has_key ? t('Saved. Leave empty to keep it') : '';

			const isDefault = el('input');
			isDefault.type = 'radio';
			isDefault.name = 'default_provider';
			isDefault.checked = this.settings.default_provider === p.id;

			const result = el('span', 'zbxagent-status');
			const test = el('button', 'btn-alt', t('Test'));
			const remove = el('button', 'btn-alt', t('Remove'));

			test.type = 'button';
			remove.type = 'button';
			remove.addEventListener('click', () => row.remove());

			const read = () => ({
				id: p.id,
				name: name.value,
				type: type.value,
				base_url: baseUrl.value,
				model: model.value,
				max_tokens: Number(maxTokens.value),
				key: key.value
			});

			test.addEventListener('click', async () => {
				result.textContent = t('Testing…');
				result.className = 'zbxagent-status';

				try {
					const response = await post('agent.provider.test', this.config.tokens.test, this.config.csrf_name, read());
					const data = await response.json();

					result.textContent = data.error || (t('It works') + ': ' + data.model);
					result.classList.add(data.error ? 'is-error' : 'is-ok');
				}
				catch (e) {
					result.textContent = e.message;
					result.classList.add('is-error');
				}
			});

			row.read = read;
			row.isDefault = isDefault;

			const actions = el('div', 'zbxagent-provider-actions');
			const defaultLabel = el('label');

			defaultLabel.append(isDefault, document.createTextNode(' ' + t('Default')));
			actions.append(defaultLabel, test, remove, result);

			row.append(
				this.field(t('Name'), name),
				this.field(t('API type'), type),
				this.field(t('Base URL'), baseUrl, t('Example: https://api.openai.com/v1 or https://api.anthropic.com')),
				this.field(t('Model'), model),
				this.field(t('Maximum output tokens'), maxTokens),
				this.field(t('API key'), key),
				actions
			);
			this.list.append(row);
		}

		async save() {
			const rows = Array.from(this.list.children);
			const selected = rows.find((row) => row.isDefault.checked);

			this.status.textContent = t('Saving…');
			this.status.className = 'zbxagent-status';

			try {
				const response = await post('agent.settings.update', this.config.tokens.save, this.config.csrf_name, {
					mcp_url: this.mcpUrl.value,
					max_steps: Number(this.maxSteps.value),
					context_tokens: Number(this.contextTokens.value),
					instructions: this.instructions.value,
					default_provider: selected ? selected.read().id : '',
					providers: rows.map((row) => row.read())
				});
				const data = await response.json();

				if (data.error) {
					this.status.textContent = data.error;
					this.status.classList.add('is-error');
					return;
				}

				this.settings = data.settings;
				this.render();
				this.status.textContent = t('Saved.');
				this.status.classList.add('is-ok');
			}
			catch (e) {
				this.status.textContent = e.message;
				this.status.classList.add('is-error');
			}
		}
	}

	function start() {
		const chat = document.getElementById('zbxagent');
		const settings = document.getElementById('zbxagent-settings');
		const root = chat || settings;

		if (!root) {
			return;
		}

		const config = JSON.parse(root.dataset.config);

		lang = config.lang || {};

		if (chat) {
			new Agent(chat, config);
		}
		else {
			new SettingsForm(settings, config);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	}
	else {
		start();
	}
})();
