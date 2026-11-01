/*
 * AI agent: the chat of the module. The browser drives the agent: it asks the server for one turn of the model, runs the
 * tools that turn requests, asks the user to approve changes, and goes on until the model stops calling tools.
 *
 * The chat floats on every page of Zabbix. Zabbix loads a new page on each navigation, so every step is saved in this
 * browser and the next page goes on from the last saved step. One tab runs the agent at a time; the others follow it.
 */
(function () {
	'use strict';

	const MODES = ['ask', 'plan', 'auto'];
	const SIZES = ['min', 'normal', 'wide'];
	const SESSIONS_KEPT = 30;
	const LOCK_TTL = 6000;
	const HANDOFF_MS = 3000;
	const RESUME_WINDOW = 30 * 60 * 1000;
	const TOOLS_TTL = 10 * 60 * 1000;
	const UNCERTAIN = 'Interrupted while it was being applied: it is not known whether this change was applied.'
		+ ' Check the current state before trying it again.';

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

	/* Icons drawn for this module, inline so they follow the color of the text. */
	const ICONS = {
		spark: '<path d="M12 2.5l2.1 6.6 6.4 2.9-6.4 2.9L12 21.5l-2.1-6.6L3.5 12l6.4-2.9z" fill="currentColor" stroke="none"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
		stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
		min: '<path d="M6 12h12"/>',
		normal: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
		wide: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
		narrow: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
		close: '<path d="M6 6l12 12M18 6L6 18"/>',
		gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
		page: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
	};

	let lang = {};
	const t = (text) => lang[text] || text;

	const randomId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

	/* The same browser tab keeps its id from one page of Zabbix to the next; each page has its own. */
	const PAGE = randomId();
	const TAB = (() => {
		try {
			let id = sessionStorage.getItem('zbxagent.tab');

			if (!id) {
				id = randomId();
				sessionStorage.setItem('zbxagent.tab', id);
			}

			return id;
		}
		catch (e) {
			return PAGE;
		}
	})();

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

	function icon(name) {
		return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"'
			+ ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
	}

	function iconButton(name, label, className) {
		const button = el('button', 'zbxagent-icon' + (className ? ' ' + className : ''));

		button.type = 'button';
		button.innerHTML = icon(name);
		button.title = label;
		button.setAttribute('aria-label', label);

		return button;
	}

	function readJson(storage, key, fallback) {
		try {
			const value = JSON.parse(storage.getItem(key));

			return value === null ? fallback : value;
		}
		catch (e) {
			return fallback;
		}
	}

	function writeJson(storage, key, value) {
		try {
			storage.setItem(key, JSON.stringify(value));
			return true;
		}
		catch (e) {
			return false;
		}
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
			else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
				closeList();
				html.push('<hr>');
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
			const sessions = readJson(localStorage, this.key, []);

			return Array.isArray(sessions) ? sessions : [];
		}

		save(sessions) {
			let kept = sessions.slice(0, SESSIONS_KEPT);

			while (kept.length > 0 && !writeJson(localStorage, this.key, kept)) {
				kept = kept.slice(0, -1);
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

	/*
	 * Only one page runs the agent at a time. The page that runs it renews this lock every 2 s. When it leaves, it marks
	 * the lock as released: the next page of the same tab takes it at once, and any other tab after a few seconds.
	 */
	class Lock {
		constructor(userid) {
			this.key = 'zbxagent.' + userid + '.lock';
			this.timer = null;
			this.session = null;
		}

		read() {
			return readJson(localStorage, this.key, null);
		}

		mine() {
			const lock = this.read();

			return lock !== null && lock.page === PAGE;
		}

		canTake() {
			const lock = this.read();

			if (lock === null || lock.page === PAGE) {
				return true;
			}

			const age = Date.now() - lock.ts;

			return lock.released ? (lock.tab === TAB || age > HANDOFF_MS) : age > LOCK_TTL;
		}

		/* The id of the chat that another page is running, or null. */
		elsewhere() {
			const lock = this.read();

			return lock !== null && lock.page !== PAGE && !lock.released && Date.now() - lock.ts <= LOCK_TTL
				? lock.session
				: null;
		}

		async take(session) {
			if (!this.canTake()) {
				return false;
			}

			this.session = session;
			this.beat();

			// Two tabs can try at once: the last one that wrote keeps it.
			await new Promise((resolve) => setTimeout(resolve, 80));

			if (!this.mine()) {
				return false;
			}

			this.timer = setInterval(() => this.beat(), 2000);

			return true;
		}

		beat() {
			writeJson(localStorage, this.key, {tab: TAB, page: PAGE, session: this.session, ts: Date.now()});
		}

		release(handoff) {
			clearInterval(this.timer);
			this.timer = null;

			if (!this.mine()) {
				return;
			}

			if (handoff) {
				writeJson(localStorage, this.key, {tab: TAB, page: PAGE, session: this.session, ts: Date.now(),
					released: true});
			}
			else {
				try {
					localStorage.removeItem(this.key);
				}
				catch (e) {
					// Nothing to release.
				}
			}
		}
	}

	/* Messages between the pages of this user that are open in this browser: live text and stop requests. */
	class Bus {
		constructor(userid, handler) {
			this.key = 'zbxagent.' + userid + '.bus';
			this.channel = null;

			if (typeof BroadcastChannel === 'function') {
				this.channel = new BroadcastChannel(this.key);
				this.channel.onmessage = (e) => handler(e.data);
			}
			else {
				window.addEventListener('storage', (e) => {
					if (e.key === this.key && e.newValue) {
						handler(readJson(localStorage, this.key, {}).message);
					}
				});
			}
		}

		send(message) {
			if (this.channel) {
				this.channel.postMessage(message);
			}
			else {
				writeJson(localStorage, this.key, {message, n: randomId()});
			}
		}
	}

	/* What the user had open, so that the next page shows the same. */
	class UiState {
		constructor(userid) {
			this.key = 'zbxagent.' + userid + '.ui';
		}

		get() {
			return Object.assign({open: false, size: 'normal', last: 'normal', session: '', draft: '', mode: 'ask',
				provider: '', scroll: null}, readJson(localStorage, this.key, {}));
		}

		set(values) {
			writeJson(localStorage, this.key, Object.assign(this.get(), values));
		}
	}

	class Agent {
		/**
		 * @param {HTMLElement} root    Where the chat is built.
		 * @param {Object}      config  From the server.
		 * @param {Object}      host    The page or the floating panel: status(state), escape(), visible().
		 */
		constructor(root, config, host) {
			this.root = root;
			this.config = config;
			this.host = host || {};
			this.store = new Store(config.userid);
			this.lock = new Lock(config.userid);
			this.ui = new UiState(config.userid);
			this.bus = new Bus(config.userid, (message) => this.onMessage(message));
			this.sessions = this.store.load();
			this.session = null;
			this.tools = null;
			this.running = false;
			this.remote = null;
			this.unloading = false;
			this.abort = null;
			this.pending = null;
			this.liveNode = null;
			this.liveSent = 0;

			const ui = this.ui.get();

			this.mode = MODES.includes(ui.mode) ? ui.mode : 'ask';
			this.provider = config.providers.some((p) => p.id === ui.provider) ? ui.provider : config.default_provider;

			this.build();

			const saved = this.sessions.find((s) => s.id === ui.session);

			if (saved) {
				this.session = saved;
				this.renderSession();

				if (ui.scroll !== null) {
					this.log.scrollTop = ui.scroll;
				}
			}
			else {
				// A chat with no messages yet is not stored: keep its id, so that every tab shows the same one.
				this.newSession(ui.session);
			}

			this.input.value = ui.draft || '';
			this.fitInput();

			window.addEventListener('pagehide', () => this.leave());
			window.addEventListener('storage', (e) => this.onStorage(e));
			setInterval(() => this.tick(), 2000);
			this.tick();
		}

		call(action, token, payload, signal) {
			return post(action, token, this.config.csrf_name, payload, signal);
		}

		status(state) {
			if (this.host.status) {
				this.host.status(state);
			}
		}

		/* Interface */

		build() {
			const bar = el('div', 'zbxagent-bar');

			this.sessionSelect = el('select', 'zbxagent-sessions');
			this.sessionSelect.setAttribute('aria-label', t('Chats'));
			this.sessionSelect.addEventListener('change', () => this.openSession(this.sessionSelect.value));

			const newButton = el('button', 'zbxagent-new');
			newButton.type = 'button';
			newButton.innerHTML = icon('plus');
			newButton.append(el('span', '', t('New chat')));
			newButton.addEventListener('click', () => this.newSession());

			this.usageLabel = el('span', 'zbxagent-usage');

			bar.append(this.sessionSelect, newButton, this.usageLabel);

			this.remoteBar = el('div', 'zbxagent-remote',
				t('The agent is working on this chat in another tab. You can follow it here.'));
			this.remoteBar.hidden = true;

			this.todosBox = el('div', 'zbxagent-todos');
			this.todosBox.hidden = true;

			this.log = el('div', 'zbxagent-log');
			this.log.setAttribute('role', 'log');
			this.log.setAttribute('aria-live', 'polite');

			this.palette = el('div', 'zbxagent-palette');
			this.palette.hidden = true;

			this.input = el('textarea', 'zbxagent-input');
			this.input.rows = 1;
			this.input.placeholder = t('Ask about your monitoring, or type / for commands');
			this.input.setAttribute('aria-label', t('Message'));
			this.input.addEventListener('keydown', (e) => this.onKey(e));
			this.input.addEventListener('input', () => {
				this.updatePalette();
				this.fitInput();
				clearTimeout(this.draftTimer);
				this.draftTimer = setTimeout(() => this.ui.set({draft: this.input.value}), 300);
			});

			this.modeButton = el('button', 'zbxagent-pill zbxagent-mode');
			this.modeButton.type = 'button';
			this.modeButton.title = t('Shift+Tab changes the mode');
			this.modeButton.addEventListener('click', () => this.cycleMode());

			this.providerSelect = el('select', 'zbxagent-pill zbxagent-provider');
			this.providerSelect.setAttribute('aria-label', t('Provider'));
			this.config.providers.forEach((p) => {
				const option = el('option', '', p.name + ' · ' + p.model);

				option.value = p.id;
				option.selected = p.id === this.provider;
				this.providerSelect.append(option);
			});
			this.providerSelect.hidden = this.config.providers.length === 0;
			this.providerSelect.addEventListener('change', () => {
				this.provider = this.providerSelect.value;
				this.ui.set({provider: this.provider});
			});

			this.sendButton = el('button', 'zbxagent-send');
			this.sendButton.type = 'button';
			this.sendButton.addEventListener('click', () => {
				if (this.running) {
					this.stop();
				}
				else if (this.remote) {
					this.bus.send({type: 'stop', session: this.remote});
				}
				else {
					this.submit();
				}
			});

			const tools = el('div', 'zbxagent-compose-tools');
			tools.append(this.modeButton, this.providerSelect, el('span', 'zbxagent-spacer'), this.sendButton);

			const composer = el('div', 'zbxagent-compose');
			composer.append(this.palette, this.input, tools);
			composer.addEventListener('click', (e) => {
				if (e.target === composer) {
					this.input.focus();
				}
			});

			const foot = el('div', 'zbxagent-foot',
				t('What the tools return, including values and internal addresses, is sent to the selected provider.'));
			foot.title = t('Shift+Tab changes the mode · Enter sends · Shift+Enter adds a line');

			this.root.append(bar, this.remoteBar, this.todosBox, this.log, composer, foot);
			this.updateMode();
			this.updateSend();

			if (this.config.providers.length === 0) {
				this.system(this.config.is_admin
					? t('There are no providers yet: add one in Settings.')
					: t('There are no providers yet: ask an administrator to add one.'));
			}
		}

		fitInput() {
			this.input.style.height = 'auto';
			this.input.style.height = Math.min(this.input.scrollHeight, 220) + 'px';
		}

		updateSend() {
			const stop = this.running || this.remote !== null;

			this.sendButton.innerHTML = icon(stop ? 'stop' : 'up');
			this.sendButton.title = stop ? t('Stop') : t('Send');
			this.sendButton.setAttribute('aria-label', this.sendButton.title);
			this.sendButton.classList.toggle('is-stop', stop);
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

		newSession(id) {
			if (this.running) {
				return;
			}

			this.session = {
				id: id || randomId(),
				title: '',
				messages: [],
				todos: [],
				allowed: [],
				usage: {input: 0, output: 0, last: 0}
			};
			this.ui.set({session: this.session.id, scroll: null});
			this.renderSession();
			this.tick();
		}

		openSession(id) {
			const session = this.sessions.find((s) => s.id === id);

			if (session && !this.running) {
				this.session = session;
				this.ui.set({session: id, scroll: null});
				this.renderSession();
				this.tick();
			}
		}

		/* Other pages save too: start from what is stored, so that nothing of theirs is lost. */
		persist() {
			if (this.session.messages.length === 0) {
				return;
			}

			if (this.session.run) {
				this.session.run.ts = Date.now();
			}

			this.sessions = [this.session].concat(this.store.load().filter((s) => s.id !== this.session.id));
			this.store.save(this.sessions);
			this.refreshSessions();
		}

		renderSession() {
			this.log.textContent = '';
			this.toolBlocks = {};
			this.liveNode = null;
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
			const mark = el('div', 'zbxagent-welcome-mark');

			mark.innerHTML = icon('spark');
			box.append(mark, el('strong', '', t('What do you want to look at?')));

			[
				t('Which problems are active, and what do they have in common?'),
				t('Which hosts are unavailable, and since when?'),
				t('Review the maintenance periods and tell me which ones are active.')
			].forEach((question) => {
				const button = el('button', 'zbxagent-suggestion', question);

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
			const row = el('div', 'zbxagent-user-row');

			row.append(el('div', 'zbxagent-user', text));
			this.log.append(row);
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
			const state = el('span', 'zbxagent-tool-state');
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

			this.usageLabel.textContent = u.input + u.output === 0 ? ''
				: u.input.toLocaleString() + ' ↑ ' + u.output.toLocaleString() + ' ↓';
			this.usageLabel.title = t('Tokens');
		}

		updateMode() {
			this.modeButton.textContent = {
				ask: t('Ask before changes'),
				plan: t('Plan (read only)'),
				auto: t('Auto (applies changes)')
			}[this.mode];
			this.modeButton.className = 'zbxagent-pill zbxagent-mode is-' + this.mode;
		}

		cycleMode() {
			this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
			this.ui.set({mode: this.mode});
			this.updateMode();
		}

		setRunning(running) {
			this.running = running;
			this.updateSend();
			this.providerSelect.disabled = running;
			this.sessionSelect.disabled = running;

			if (!running) {
				this.status('idle');
			}
		}

		/* Another page runs this chat: follow it, and allow only stopping it. */
		setRemote(session) {
			const remote = session !== null && session === this.session.id ? session : null;
			const busy = session !== null;

			this.remoteBar.hidden = remote === null;
			this.input.disabled = remote !== null;

			if (remote !== this.remote) {
				this.remote = remote;
				this.updateSend();
			}

			if (!this.running) {
				this.status(busy ? 'remote' : 'idle');
			}
		}

		/* Every 2 s and when something changes: who runs the agent, and whether this page must go on with it. */
		tick() {
			if (this.running || this.unloading) {
				return;
			}

			this.setRemote(this.lock.elsewhere());

			const run = this.session.run;

			if (!run || this.remote !== null || this.starting) {
				return;
			}

			if (Date.now() - (run.ts || 0) > RESUME_WINDOW) {
				const executing = run.executing;

				delete this.session.run;
				this.closeOpenCalls(t('Interrupted: the page was closed before this finished.'), executing);
				this.persist();
				return;
			}

			if (this.lock.canTake()) {
				this.run(true);
			}
		}

		onStorage(e) {
			if (e.key === this.ui.key && !this.running && this.session.messages.length === 0) {
				const ui = this.ui.get();

				// Another tab started a new chat while this one shows an empty one: show the same.
				if (ui.session && ui.session !== this.session.id) {
					const saved = this.store.load().find((s) => s.id === ui.session);

					saved ? this.openSession(ui.session) : this.newSession(ui.session);
				}
			}
			else if (e.key === this.store.key && !this.running) {
				this.sessions = this.store.load();

				const fresh = this.sessions.find((s) => s.id === this.session.id);

				if (fresh && JSON.stringify(fresh) !== JSON.stringify(this.session)) {
					this.session = fresh;
					this.renderSession();
				}
				else {
					this.refreshSessions();
				}
			}
			else if (e.key === this.lock.key) {
				this.tick();
			}
		}

		onMessage(message) {
			if (!message || typeof message !== 'object') {
				return;
			}

			if (message.type === 'stop' && this.running && this.lock.mine() && message.session === this.session.id) {
				this.stop();
			}
			else if (message.type === 'live' && !this.running && message.session === this.session.id) {
				if (!this.liveNode) {
					this.liveNode = this.addAssistant();
					this.liveNode.classList.add('is-live');
				}

				this.liveNode.innerHTML = markdown(message.text);
				this.scroll();
			}
		}

		/* Zabbix is loading another page: keep everything so that page goes on from here. */
		leave() {
			this.unloading = true;
			this.ui.set({draft: this.input.value, scroll: this.log.scrollTop, session: this.session.id});

			if (this.running) {
				this.persist();
				this.lock.release(true);
			}
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
			else if (e.key === 'Escape') {
				if (this.running) {
					this.stop();
				}
				else if (this.host.escape) {
					this.host.escape();
				}
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

		clearInput() {
			this.input.value = '';
			this.fitInput();
			this.palette.hidden = true;
			this.ui.set({draft: ''});
		}

		submit() {
			const text = this.input.value.trim();

			if (text === '' || this.running) {
				return;
			}

			if (text.startsWith('/')) {
				this.clearInput();
				this.command(text);
				return;
			}

			if (!this.provider) {
				this.system(t('There are no providers yet: add one in Settings.'), 'is-error');
				return;
			}

			if (this.lock.elsewhere() !== null) {
				this.system(t('The agent is working in another tab. Wait for it to finish, or stop it.'), 'is-warning');
				return;
			}

			this.clearInput();

			if (!this.session.title) {
				this.session.title = text.slice(0, 50);
			}

			this.log.querySelector('.zbxagent-welcome')?.remove();
			this.session.messages.push({role: 'user', content: text});
			this.addUser(text);
			this.persist();
			this.run(false);
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
						this.ui.set({mode: arg});
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
						this.ui.set({provider: found.id});
					}

					this.system(this.config.providers.map((p) =>
						(p.id === this.provider ? '● ' : '○ ') + p.id + ' — ' + p.name + ' · ' + p.model
					).join('\n'));
					break;
				}

				case '/tools':
					this.loadTools().then(() => this.system(this.tools.map((tool) =>
						(tool.read_only ? '○ ' : '✎ ') + tool.name + ' — ' + tool.title
					).join('\n') || t('No tools available.')));
					break;

				case '/sessions':
					this.system(this.sessions.map((s) => '• ' + s.title).join('\n') || t('No saved chats.'));
					break;

				case '/forget':
					if (this.lock.elsewhere() !== null) {
						this.system(t('The agent is working in another tab. Wait for it to finish, or stop it.'),
							'is-warning');
						break;
					}

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

		/* The list of tools is kept in this tab for a few minutes, so that each page does not ask the MCP server. */
		async loadTools() {
			if (this.tools !== null) {
				return;
			}

			const key = 'zbxagent.' + this.config.userid + '.tools';
			const cached = readJson(sessionStorage, key, null);

			if (cached && Date.now() - cached.ts < TOOLS_TTL && Array.isArray(cached.tools)) {
				this.tools = cached.tools;
				return;
			}

			try {
				const response = await this.call('agent.tools', this.config.tokens.tools, {});
				const data = await response.json();

				if (data.error) {
					this.system(t('Cannot use the MCP server') + ': ' + data.error, 'is-error');
				}
				else {
					this.tools = data.tools;
					writeJson(sessionStorage, key, {ts: Date.now(), tools: data.tools});
					return;
				}
			}
			catch (e) {
				if (!this.unloading) {
					this.system(t('Cannot use the MCP server') + ': ' + e.message, 'is-error');
				}
			}

			this.tools = this.tools || [];
		}

		/* The tool calls of the last answer that have no result yet. */
		openCalls() {
			const answered = new Set(this.session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
			const last = this.session.messages.filter((m) => m.role === 'assistant').pop();

			return last ? (last.tool_calls || []).filter((call) => !answered.has(call.id)) : [];
		}

		/**
		 * @param {boolean} resume  Go on with a run that a previous page left unfinished.
		 */
		async run(resume) {
			this.starting = true;

			const taken = await this.lock.take(this.session.id);

			this.starting = false;

			if (!taken) {
				if (!resume) {
					this.system(t('The agent is working in another tab. Wait for it to finish, or stop it.'), 'is-warning');
				}

				this.tick();
				return;
			}

			this.setRunning(true);
			this.setRemote(null);
			this.abort = new AbortController();

			if (!resume || !this.session.run) {
				this.session.run = {step: 0, executing: null};
			}

			this.persist();

			try {
				await this.loadTools();

				if (resume) {
					this.system(t('Continuing after changing page…'));

					const open = this.openCalls();

					if (open.length > 0) {
						await this.runTools(open);
					}
				}

				while (!this.abort.signal.aborted) {
					const last = this.session.messages[this.session.messages.length - 1];

					if (last && last.role === 'assistant' && (last.tool_calls || []).length === 0) {
						break;
					}

					if (this.session.run.step >= this.config.max_steps) {
						this.system(t('The agent reached the limit of steps. Say "continue" to go on.'), 'is-warning');
						break;
					}

					if (this.session.usage.last > this.config.context_tokens * 0.8) {
						await this.compact(true);
					}

					this.session.run.step++;

					const turn = await this.turn();

					if (!turn) {
						break;
					}

					const calls = turn.message.tool_calls || [];

					if (calls.length === 0) {
						break;
					}

					await this.runTools(calls);
				}
			}
			catch (e) {
				if (this.unloading) {
					return;
				}

				if (e.name !== 'AbortError') {
					this.system(e.message, 'is-error');
				}
			}

			// The page is leaving: the next one goes on from the last saved step.
			if (this.unloading) {
				return;
			}

			if (this.abort.signal.aborted) {
				this.system(t('Stopped.'));
			}

			const executing = this.session.run.executing;

			delete this.session.run;
			this.closeOpenCalls(t('Cancelled by the user.'), executing);
			this.setRunning(false);
			this.persist();
			this.lock.release(false);

			if (this.host.done) {
				this.host.done();
			}

			if (!this.host.visible || this.host.visible()) {
				this.input.focus();
			}
		}

		/*
		 * Every tool call needs a result, or the provider rejects the next request. A change that was already sent may
		 * have been applied: the model is told so.
		 */
		closeOpenCalls(text, executing) {
			const answered = new Set(this.session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));

			this.session.messages.slice().forEach((m) => {
				(m.tool_calls || []).forEach((call) => {
					if (!answered.has(call.id)) {
						this.addResult(call, call.id === executing ? UNCERTAIN : text, true, 0);
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

		/* Other pages show the answer as it arrives. */
		share(text) {
			const now = Date.now();

			if (now - this.liveSent > 150) {
				this.liveSent = now;
				this.bus.send({type: 'live', session: this.session.id, text});
			}
		}

		async turn() {
			this.status('thinking');

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
					this.share(text);
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

				const block = this.toolBlocks[call.id] || this.addTool(call);

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
				// A change that was being applied when the page changed is never sent twice.
				if (this.session.run.executing === call.id) {
					this.session.run.executing = null;
					this.addResult(call, UNCERTAIN, true, 0);
					return;
				}

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

				this.session.run.executing = call.id;
				this.persist();
			}

			this.status('tool');

			const response = await this.call('agent.tool', this.config.tokens.tool, {
				name: call.name,
				arguments: call.arguments,
				mode: this.mode,
				approved: approved && !readOnly
			}, this.abort.signal);
			const data = await response.json();

			this.session.run.executing = null;
			this.addResult(call, data.text, data.is_error, data.ms);
		}

		approve(call, tool) {
			this.status('approval');

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
					this.status('thinking');
					resolve(decision);
				};

				[['once', t('Allow'), 'is-primary'], ['session', t('Allow in this chat'), ''], ['reject', t('Reject'), '']]
					.forEach(([decision, label, className]) => {
						const button = el('button', 'zbxagent-button ' + className, label);

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
			this.status('question');

			return new Promise((resolve) => {
				const card = el('div', 'zbxagent-card');
				const input = el('input', 'zbxagent-card-input');
				const send = el('button', 'zbxagent-button is-primary', t('Answer'));

				input.type = 'text';
				input.setAttribute('aria-label', t('Answer'));
				send.type = 'button';

				const actions = el('div', 'zbxagent-card-actions');

				const finish = (value) => {
					this.pending = null;
					actions.replaceWith(el('div', 'zbxagent-card-result', value === null ? t('Stopped.') : value));
					this.status('thinking');
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

				if (!this.host.visible || this.host.visible()) {
					input.focus();
				}

				this.scroll();
			});
		}

		async compact(inside) {
			if (this.session.messages.length === 0) {
				return;
			}

			if (!inside) {
				if (this.running || !(await this.lock.take(this.session.id))) {
					return;
				}

				this.setRunning(true);
				this.abort = new AbortController();
			}

			const note = this.system(t('Summarizing the conversation…'));

			this.status('thinking');

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
				this.lock.release(false);
			}
		}
	}

	/*
	 * The floating chat: a button in the corner and a panel with three sizes. What is open and its size are kept for the
	 * next page and shared with the other tabs.
	 */
	class Dock {
		constructor(config) {
			this.config = config;
			this.ui = new UiState(config.userid);
			this.state = 'idle';
			this.unread = false;

			this.root = el('div');
			this.root.id = 'zbxagent-dock';

			this.backdrop = el('div', 'zbxagent-backdrop');
			this.backdrop.addEventListener('click', () => this.setSize('normal'));

			this.launcher = el('button', 'zbxagent-launcher');
			this.launcher.type = 'button';
			this.launcher.innerHTML = icon('spark');
			this.launcher.title = t('AI agent') + ' (Ctrl+.)';
			this.launcher.setAttribute('aria-label', t('AI agent'));
			this.launcher.append(el('span', 'zbxagent-badge'));
			this.launcher.addEventListener('click', () => this.open());

			this.panel = el('section', 'zbxagent-panel');
			this.panel.setAttribute('role', 'dialog');
			this.panel.setAttribute('aria-label', t('AI agent'));

			const head = el('header', 'zbxagent-head');
			const mark = el('span', 'zbxagent-mark');
			mark.innerHTML = icon('spark');

			const title = el('div', 'zbxagent-title');
			title.append(el('strong', '', t('AI agent')));
			this.statusLabel = el('span', 'zbxagent-state');
			title.append(this.statusLabel);

			const actions = el('div', 'zbxagent-head-actions');

			if (config.settings_url) {
				const settings = iconButton('gear', t('Settings'));
				settings.addEventListener('click', () => { location.href = config.settings_url; });
				actions.append(settings);
			}

			const page = iconButton('page', t('Open as a page'));
			page.addEventListener('click', () => { location.href = config.page_url; });

			this.sizeButton = iconButton('wide', t('Wide'), 'zbxagent-size');
			this.sizeButton.addEventListener('click', () => this.setSize(this.size === 'wide' ? 'normal' : 'wide'));

			const minimize = iconButton('min', t('Minimize'));
			minimize.addEventListener('click', (e) => {
				e.stopPropagation();
				this.setSize(this.size === 'min' ? this.last : 'min');
			});
			this.minimizeButton = minimize;

			const close = iconButton('close', t('Close'));
			close.addEventListener('click', (e) => {
				e.stopPropagation();
				this.close();
			});

			actions.append(page, this.sizeButton, minimize, close);
			head.append(mark, title, actions);
			head.addEventListener('click', (e) => {
				if (this.size === 'min' && !e.target.closest('button')) {
					this.setSize(this.last);
				}
			});

			this.body = el('div', 'zbxagent-body');

			const chat = el('div');
			chat.id = 'zbxagent';
			this.body.append(chat);

			this.panel.append(head, this.body);
			this.panel.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !e.defaultPrevented && e.target.closest('.zbxagent-input') === null) {
					this.escape();
				}
			});

			this.root.append(this.backdrop, this.panel, this.launcher);
			document.body.append(this.root);

			const ui = this.ui.get();

			this.isOpen = ui.open;
			this.size = SIZES.includes(ui.size) ? ui.size : 'normal';
			this.last = ui.last === 'wide' ? 'wide' : 'normal';
			this.render();

			this.agent = new Agent(chat, config, {
				status: (state) => this.status(state),
				escape: () => this.escape(),
				visible: () => this.isOpen && this.size !== 'min',
				done: () => {
					if (!this.isOpen || this.size === 'min') {
						this.unread = true;
						this.render();
					}
				}
			});

			document.addEventListener('keydown', (e) => {
				if ((e.ctrlKey || e.metaKey) && e.key === '.') {
					e.preventDefault();
					this.isOpen ? this.close() : this.open();
				}
			});

			window.addEventListener('storage', (e) => {
				if (e.key === this.ui.key) {
					const fresh = this.ui.get();

					if (fresh.open !== this.isOpen || fresh.size !== this.size) {
						this.isOpen = fresh.open;
						this.size = SIZES.includes(fresh.size) ? fresh.size : 'normal';
						this.last = fresh.last === 'wide' ? 'wide' : 'normal';
						this.render();
					}
				}
			});
		}

		open() {
			this.isOpen = true;

			if (this.size === 'min') {
				this.size = this.last;
			}

			this.unread = false;
			this.save();
			this.render();
			this.animate();
			this.agent.scroll();
			this.agent.input.focus();
		}

		/* Only when the user opens or resizes it: what the previous page had open appears without moving. */
		animate() {
			this.panel.classList.remove('is-anim');
			void this.panel.offsetWidth;
			this.panel.classList.add('is-anim');
			clearTimeout(this.animTimer);
			this.animTimer = setTimeout(() => this.panel.classList.remove('is-anim'), 250);
		}

		close() {
			this.isOpen = false;
			this.save();
			this.render();
			this.launcher.focus();
		}

		setSize(size) {
			if (size !== 'min') {
				this.last = size;
				this.unread = false;
			}

			this.size = size;
			this.isOpen = true;
			this.save();
			this.render();
			this.animate();

			if (size !== 'min') {
				this.agent.scroll();
				this.agent.input.focus();
			}
		}

		escape() {
			if (this.size === 'wide') {
				this.setSize('normal');
			}
			else if (this.size === 'normal') {
				this.setSize('min');
			}
		}

		save() {
			this.ui.set({open: this.isOpen, size: this.size, last: this.last});
		}

		status(state) {
			this.state = state;
			this.render();
		}

		render() {
			const busy = this.state !== 'idle';
			const needs = this.state === 'approval' || this.state === 'question';

			this.root.dataset.open = this.isOpen ? 'true' : 'false';
			this.root.dataset.size = this.size;
			this.root.classList.toggle('is-busy', busy);
			this.root.classList.toggle('needs-you', needs);
			this.root.classList.toggle('has-unread', this.unread);
			this.launcher.hidden = this.isOpen;
			this.panel.hidden = !this.isOpen;
			this.backdrop.hidden = !this.isOpen || this.size !== 'wide';

			this.statusLabel.textContent = {
				idle: '',
				thinking: t('Thinking…'),
				tool: t('Using a tool…'),
				approval: t('Waiting for your approval'),
				question: t('Waiting for your answer'),
				remote: t('Working in another tab')
			}[this.state] || '';

			const wide = this.size === 'wide';

			this.sizeButton.innerHTML = icon(wide ? 'narrow' : 'wide');
			this.sizeButton.title = wide ? t('Normal size') : t('Wide');
			this.sizeButton.setAttribute('aria-label', this.sizeButton.title);
			this.minimizeButton.innerHTML = icon(this.size === 'min' ? 'normal' : 'min');
			this.minimizeButton.title = this.size === 'min' ? t('Restore') : t('Minimize');
			this.minimizeButton.setAttribute('aria-label', this.minimizeButton.title);
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

	/*
	 * The chat page shows the chat in full; the settings page shows its form. Every other page of Zabbix gets the
	 * floating chat, except kiosk mode and pages inside frames.
	 */
	async function start() {
		const chat = document.getElementById('zbxagent');
		const settings = document.getElementById('zbxagent-settings');

		if (chat) {
			const config = JSON.parse(chat.dataset.config);

			lang = config.lang || {};
			new Agent(chat, config, {});
			return;
		}

		if (settings) {
			const config = JSON.parse(settings.dataset.config);

			lang = config.lang || {};
			new SettingsForm(settings, config);
		}

		if (window.top !== window || document.querySelector('.layout-kioskmode') !== null
				|| document.querySelector('aside.sidebar') === null) {
			return;
		}

		let config;

		try {
			const response = await fetch('zabbix.php?action=agent.config', {credentials: 'same-origin'});

			config = (await response.json()).config;
		}
		catch (e) {
			return;
		}

		if (!config || !config.userid) {
			return;
		}

		lang = config.lang || {};
		new Dock(config);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	}
	else {
		start();
	}
})();
