<?php declare(strict_types = 0);

/*
 * Checks that run without Zabbix or a provider (php tests/run.php): messages per provider, parsers of the streams,
 * responses of the MCP server, encryption and translations. Exit code 1 on any failure.
 */

namespace {
	$root = dirname(__DIR__).'/modules/ZabbixAgent/includes';

	foreach (['I18n', 'Crypto', 'Llm', 'StreamParser', 'McpClient', 'Prompt'] as $class) {
		require $root.'/'.$class.'.php';
	}

	$failures = 0;

	function check(string $name, $actual, $expected): void {
		global $failures;

		if ($actual !== $expected) {
			$failures++;
			echo "FAIL $name\n  expected: ".json_encode($expected)."\n  actual:   ".json_encode($actual)."\n";
		}
	}
}

namespace Modules\ZabbixAgent\Includes {

	$conversation = [
		['role' => 'user', 'content' => 'hi'],
		['role' => 'assistant', 'content' => 'Looking', 'reasoning' => 'think', 'tool_calls' => [
			['id' => 'a', 'name' => 'host_get', 'arguments' => ['limit' => 1]],
			['id' => 'b', 'name' => 'problem_get', 'arguments' => []]
		]],
		['role' => 'tool', 'tool_call_id' => 'a', 'name' => 'host_get', 'content' => 'A'],
		['role' => 'tool', 'tool_call_id' => 'b', 'name' => 'problem_get', 'content' => 'B', 'is_error' => true]
	];

	// OpenAI: one message per tool result, arguments as a JSON string, reasoning sent back.
	$openai = Llm::toOpenAi('sys', $conversation);
	check('openai system', $openai[0], ['role' => 'system', 'content' => 'sys']);
	check('openai arguments', $openai[2]['tool_calls'][0]['function']['arguments'], '{"limit":1}');
	check('openai empty arguments', $openai[2]['tool_calls'][1]['function']['arguments'], '{}');
	check('openai reasoning', $openai[2]['reasoning_content'], 'think');
	check('openai results', array_column($openai, 'role'), ['system', 'user', 'assistant', 'tool', 'tool']);

	// Anthropic: results of a turn together in one user message.
	$anthropic = Llm::toAnthropic($conversation);
	check('anthropic roles', array_column($anthropic, 'role'), ['user', 'assistant', 'user']);
	check('anthropic results', count($anthropic[2]['content']), 2);
	check('anthropic error', $anthropic[2]['content'][1]['is_error'], true);
	check('anthropic blocks', array_column($anthropic[1]['content'], 'type'), ['text', 'tool_use', 'tool_use']);
	check('anthropic empty input', json_encode($anthropic[1]['content'][2]['input']), '{}');

	$tools = [['name' => 't', 'description' => 'd', 'inputSchema' => ['type' => 'object']]];
	$request = Llm::buildRequest(['type' => 'anthropic', 'model' => 'm', 'max_tokens' => 5,
		'base_url' => 'https://x'], 'K', 's', [], $tools);
	check('anthropic url', $request['url'], 'https://x/v1/messages');
	check('anthropic key header', $request['headers'][0], 'x-api-key: K');
	check('anthropic tool', $request['body']['tools'][0]['input_schema'], ['type' => 'object']);

	$request = Llm::buildRequest(['type' => 'openai', 'model' => 'm', 'max_tokens' => 5,
		'base_url' => 'https://x/v1'], 'K', 's', [], $tools);
	check('openai url', $request['url'], 'https://x/v1/chat/completions');
	check('openai key header', $request['headers'][0], 'Authorization: Bearer K');
	check('openai tool', $request['body']['tools'][0]['function']['parameters'], ['type' => 'object']);

	// Streams, cut at any byte.
	$feed = static function (string $type, string $stream, int $size) {
		$events = [];
		$parser = Llm::parser($type, static function (string $t, $v) use (&$events): void { $events[] = [$t, $v]; });

		foreach (str_split($stream, $size) as $chunk) {
			$parser->feed($chunk);
		}

		return [$parser->finish(), $events];
	};

	$stream = 'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}'."\n\n"
		.'data: {"choices":[{"delta":{"content":"Hé"}}]}'."\n\n"
		.'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"host_get","arguments":"{\"li"}}]}}]}'."\n\n"
		.'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mit\":2}"}}]},"finish_reason":"tool_calls"}]}'."\n\n"
		.'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}'."\n\n"
		."data: [DONE]\n\n";

	foreach ([1, 7, strlen($stream)] as $size) {
		[$done, $events] = $feed('openai', $stream, $size);
		check("openai stream text $size", $done['message']['content'], 'Hé');
		check("openai stream call $size", $done['message']['tool_calls'],
			[['id' => 'c1', 'name' => 'host_get', 'arguments' => ['limit' => 2]]]
		);
		check("openai stream usage $size", $done['usage'], ['input' => 10, 'output' => 3]);
		check("openai stream stop $size", $done['stop'], 'tool_calls');
		check("openai stream events $size", $events, [['reasoning', 'r'], ['text', 'Hé']]);
	}

	$stream = 'event: message_start'."\n".'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}'."\n\n"
		.'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}'."\n\n"
		.'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"r"}}'."\n\n"
		.'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}'."\n\n"
		.'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}'."\n\n"
		.'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Ok"}}'."\n\n"
		.'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"host_get"}}'."\n\n"
		.'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}'."\n\n"
		.'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}'."\n\n";

	foreach ([1, 7, strlen($stream)] as $size) {
		[$done, $events] = $feed('anthropic', $stream, $size);
		check("anthropic stream text $size", $done['message']['content'], 'Ok');
		check("anthropic stream call $size", $done['message']['tool_calls'],
			[['id' => 't1', 'name' => 'host_get', 'arguments' => ['a' => 1]]]
		);
		check("anthropic stream thinking $size", $done['message']['thinking'],
			[['type' => 'thinking', 'thinking' => 'r', 'signature' => 's']]
		);
		check("anthropic stream usage $size", $done['usage'], ['input' => 9, 'output' => 4]);
		check("anthropic stream events $size", $events, [['reasoning', 'r'], ['text', 'Ok']]);
	}

	// A call without arguments, and arguments that are not JSON, do not break the turn.
	[$done] = $feed('openai', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"n","arguments":"{bad"}}]}}]}'."\n\n", 50);
	check('bad arguments', $done['message']['tool_calls'][0]['arguments'], []);

	$threw = false;

	try {
		$feed('openai', 'data: {"error":{"message":"boom"}}'."\n\n", 10);
	}
	catch (\RuntimeException $e) {
		$threw = $e->getMessage() === 'boom';
	}

	check('stream error', $threw, true);
	check('error message', Llm::errorMessage(401, '{"error":{"message":"bad key"}}'), 'HTTP 401: bad key');
	check('error message, not JSON', Llm::errorMessage(502, '<html>'), 'HTTP 502: <html>');

	// MCP.
	check('mcp json', McpClient::parseBody('{"id":1}'), ['id' => 1]);
	check('mcp sse', McpClient::parseBody("event: message\ndata: {\"id\":2}\n\n"), ['id' => 2]);
	check('mcp text', McpClient::toolResult(['content' => [['type' => 'text', 'text' => 'a'], ['type' => 'image'],
		['type' => 'text', 'text' => 'b']]]), ['text' => "a\nb", 'is_error' => false]);
	check('mcp error', McpClient::toolResult(['isError' => true])['is_error'], true);

	// Only an explicit read-only hint skips the approval.
	check('read only', McpClient::isReadOnly(['annotations' => ['readOnlyHint' => true]]), true);
	check('not read only', McpClient::isReadOnly(['annotations' => ['readOnlyHint' => false]]), false);
	check('no hint', McpClient::isReadOnly([]), false);

	// Encryption.
	$key = str_repeat('k', 32);
	$stored = Crypto::encrypt('secret', $key);
	check('crypto round trip', Crypto::decrypt($stored, $key), 'secret');
	check('crypto hides', strpos(base64_decode($stored), 'secret'), false);
	check('crypto random', Crypto::encrypt('secret', $key) === $stored, false);

	foreach ([str_repeat('z', 32), $key] as $i => $other) {
		$threw = false;

		try {
			Crypto::decrypt($i === 0 ? $stored : base64_encode(substr(base64_decode($stored), 0, -1).'x'), $other);
		}
		catch (\RuntimeException $e) {
			$threw = true;
		}

		check('crypto rejects '.$i, $threw, true);
	}

	// Prompt.
	check('plan prompt', strpos(Prompt::build('plan', '', 'u', 0), 'Plan mode is active') !== false, true);
	check('ask prompt', strpos(Prompt::build('ask', '', 'u', 0), 'Plan mode is active'), false);
	check('instructions', strpos(Prompt::build('ask', 'Be kind', 'u', 0), 'Be kind') !== false, true);

	// The floating chat asks every page for its configuration.
	$manifest = json_decode(file_get_contents(dirname(__DIR__).'/modules/ZabbixAgent/manifest.json'), true);
	check('config action', $manifest['actions']['agent.config']['class'] ?? null, 'Config');
	check('assets on every page', $manifest['assets']['js'] ?? null, ['agent.js']);

	// Translations: everything used by the code exists in Spanish.
	$module = dirname(__DIR__).'/modules/ZabbixAgent';
	$catalog = require $module.'/lang/es.php';
	$files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($module, \FilesystemIterator::SKIP_DOTS));

	foreach ($files as $file) {
		if (!preg_match('/\.(php|js)$/', (string) $file) || strpos((string) $file, '/lang/') !== false) {
			continue;
		}

		preg_match_all("/(?:I18n::t|\\bt)\\('((?:[^'\\\\]|\\\\.)*)'\\)/", file_get_contents((string) $file), $matches);

		foreach ($matches[1] as $text) {
			$text = stripcslashes($text);
			check('translated: '.$text, array_key_exists($text, $catalog), true);
		}
	}

	global $failures;

	echo $failures === 0 ? "OK\n" : "$failures failure(s)\n";
	exit($failures === 0 ? 0 : 1);
}
