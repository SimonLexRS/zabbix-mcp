<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use RuntimeException;

/**
 * Providers of models, behind one form of messages:
 *   ['role' => 'user', 'content' => string]
 *   ['role' => 'assistant', 'content' => string, 'tool_calls' => [['id', 'name', 'arguments' => array]],
 *    'reasoning' => string, 'thinking' => [provider blocks to send back]]
 *   ['role' => 'tool', 'tool_call_id' => string, 'name' => string, 'content' => string, 'is_error' => bool]
 *
 * and one form of tools: ['name', 'description', 'inputSchema'].
 */
class Llm {

	public const TYPE_OPENAI = 'openai';
	public const TYPE_ANTHROPIC = 'anthropic';
	public const TYPES = [self::TYPE_OPENAI, self::TYPE_ANTHROPIC];

	private const ANTHROPIC_VERSION = '2023-06-01';

	/**
	 * Build the request of a provider.
	 *
	 * @return array  ['url' => string, 'headers' => string[], 'body' => array]
	 */
	public static function buildRequest(array $provider, string $key, string $system, array $messages, array $tools,
			bool $stream = true): array {
		if ($provider['type'] === self::TYPE_ANTHROPIC) {
			$body = [
				'model' => $provider['model'],
				'max_tokens' => (int) $provider['max_tokens'],
				'stream' => $stream,
				'messages' => self::toAnthropic($messages)
			];

			if ($system !== '') {
				$body['system'] = $system;
			}

			if ($tools) {
				$body['tools'] = array_map(static fn(array $tool): array => [
					'name' => $tool['name'],
					'description' => $tool['description'] ?? '',
					'input_schema' => $tool['inputSchema'] ?? ['type' => 'object', 'properties' => new \stdClass()]
				], $tools);
			}

			return [
				'url' => $provider['base_url'].'/v1/messages',
				'headers' => [
					'x-api-key: '.$key,
					'anthropic-version: '.self::ANTHROPIC_VERSION,
					'Content-Type: application/json'
				],
				'body' => $body
			];
		}

		$body = [
			'model' => $provider['model'],
			'max_tokens' => (int) $provider['max_tokens'],
			'stream' => $stream,
			'messages' => self::toOpenAi($system, $messages)
		];

		if ($stream) {
			$body['stream_options'] = ['include_usage' => true];
		}

		if ($tools) {
			$body['tools'] = array_map(static fn(array $tool): array => [
				'type' => 'function',
				'function' => [
					'name' => $tool['name'],
					'description' => $tool['description'] ?? '',
					'parameters' => $tool['inputSchema'] ?? ['type' => 'object', 'properties' => new \stdClass()]
				]
			], $tools);
		}

		return [
			'url' => $provider['base_url'].'/chat/completions',
			'headers' => ['Authorization: Bearer '.$key, 'Content-Type: application/json'],
			'body' => $body
		];
	}

	public static function toOpenAi(string $system, array $messages): array {
		$result = $system !== '' ? [['role' => 'system', 'content' => $system]] : [];

		foreach ($messages as $message) {
			switch ($message['role']) {
				case 'assistant':
					$item = ['role' => 'assistant', 'content' => $message['content'] ?? ''];

					if (($message['reasoning'] ?? '') !== '') {
						$item['reasoning_content'] = $message['reasoning'];
					}

					if (!empty($message['tool_calls'])) {
						$item['tool_calls'] = array_map(static fn(array $call): array => [
							'id' => $call['id'],
							'type' => 'function',
							'function' => [
								'name' => $call['name'],
								'arguments' => json_encode((object) ($call['arguments'] ?? []))
							]
						], $message['tool_calls']);
					}

					$result[] = $item;
					break;

				case 'tool':
					$result[] = [
						'role' => 'tool',
						'tool_call_id' => $message['tool_call_id'],
						'content' => $message['content']
					];
					break;

				default:
					$result[] = ['role' => 'user', 'content' => $message['content']];
			}
		}

		return $result;
	}

	public static function toAnthropic(array $messages): array {
		$result = [];

		foreach ($messages as $message) {
			switch ($message['role']) {
				case 'assistant':
					$blocks = $message['thinking'] ?? [];

					if (($message['content'] ?? '') !== '') {
						$blocks[] = ['type' => 'text', 'text' => $message['content']];
					}

					foreach ($message['tool_calls'] ?? [] as $call) {
						$blocks[] = [
							'type' => 'tool_use',
							'id' => $call['id'],
							'name' => $call['name'],
							'input' => (object) ($call['arguments'] ?? [])
						];
					}

					$result[] = ['role' => 'assistant', 'content' => $blocks];
					break;

				case 'tool':
					$block = [
						'type' => 'tool_result',
						'tool_use_id' => $message['tool_call_id'],
						'content' => $message['content']
					];

					if ($message['is_error'] ?? false) {
						$block['is_error'] = true;
					}

					// Results of one turn go together in one user message.
					$last = count($result) - 1;

					if ($last >= 0 && $result[$last]['role'] === 'user' && is_array($result[$last]['content'])) {
						$result[$last]['content'][] = $block;
					}
					else {
						$result[] = ['role' => 'user', 'content' => [$block]];
					}
					break;

				default:
					$result[] = ['role' => 'user', 'content' => $message['content']];
			}
		}

		return $result;
	}

	/**
	 * Parser of the stream of a provider: feed it with chunks, it calls $emit(type, value) for each event, and finish()
	 * returns the message of the assistant.
	 */
	public static function parser(string $type, callable $emit): StreamParser {
		return new StreamParser($type, $emit);
	}

	/**
	 * Send a request and stream it. Failures throw.
	 */
	public static function stream(array $provider, string $key, string $system, array $messages, array $tools,
			callable $emit): array {
		$request = self::buildRequest($provider, $key, $system, $messages, $tools);
		$parser = self::parser($provider['type'], $emit);
		$raw = '';

		$curl = curl_init($request['url']);

		curl_setopt_array($curl, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => json_encode($request['body']),
			CURLOPT_HTTPHEADER => $request['headers'],
			CURLOPT_CONNECTTIMEOUT => 15,
			CURLOPT_TIMEOUT => 0,
			CURLOPT_LOW_SPEED_LIMIT => 1,
			CURLOPT_LOW_SPEED_TIME => 180,
			CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use ($parser, &$raw): int {
				if (connection_aborted()) {
					return -1;
				}

				if (curl_getinfo($handle, CURLINFO_RESPONSE_CODE) === 200) {
					$parser->feed($chunk);
				}
				elseif (strlen($raw) < 2000) {
					$raw .= $chunk;
				}

				return strlen($chunk);
			}
		]);

		$ok = curl_exec($curl);
		$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
		$error = curl_error($curl);

		if ($status !== 200 && $status !== 0) {
			throw new RuntimeException(self::errorMessage($status, $raw));
		}

		if ($ok === false) {
			throw new RuntimeException(I18n::t('Cannot reach the provider').': '.$error);
		}

		return $parser->finish();
	}

	/**
	 * Check a provider with a minimal request.
	 */
	public static function test(array $provider, string $key): string {
		$request = self::buildRequest(['max_tokens' => 16] + $provider, $key, '',
			[['role' => 'user', 'content' => 'Reply with: OK']], [], false
		);

		$curl = curl_init($request['url']);

		curl_setopt_array($curl, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => json_encode($request['body']),
			CURLOPT_HTTPHEADER => $request['headers'],
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_CONNECTTIMEOUT => 15,
			CURLOPT_TIMEOUT => 60
		]);

		$body = curl_exec($curl);
		$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);

		if ($body === false) {
			throw new RuntimeException(I18n::t('Cannot reach the provider').': '.curl_error($curl));
		}

		if ($status !== 200) {
			throw new RuntimeException(self::errorMessage($status, $body));
		}

		$decoded = json_decode($body, true);

		return (string) ($decoded['model'] ?? $provider['model']);
	}

	public static function errorMessage(int $status, string $body): string {
		$decoded = json_decode($body, true);
		$detail = $decoded['error']['message'] ?? $decoded['message'] ?? substr($body, 0, 300);

		return 'HTTP '.$status.': '.(is_string($detail) ? $detail : json_encode($detail));
	}
}
