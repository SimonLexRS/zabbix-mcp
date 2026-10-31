<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use RuntimeException;

/**
 * Client of the native Zabbix MCP server (Streamable HTTP). The server is stateless, and every request carries the
 * credential of the current user, so permissions and the audit log are those of that user.
 */
class McpClient {

	private string $url;
	private string $credential;

	public function __construct(string $url, string $credential) {
		$this->url = $url;
		$this->credential = $credential;
	}

	public function listTools(): array {
		$result = $this->request('tools/list');

		return $result['tools'] ?? [];
	}

	/**
	 * @return array  ['text' => string, 'is_error' => bool]
	 */
	public function callTool(string $name, array $arguments): array {
		$result = $this->request('tools/call', ['name' => $name, 'arguments' => (object) $arguments]);

		return self::toolResult($result);
	}

	public static function isReadOnly(array $tool): bool {
		return ($tool['annotations']['readOnlyHint'] ?? false) === true;
	}

	public static function toolResult(array $result): array {
		$text = [];

		foreach ($result['content'] ?? [] as $block) {
			if (($block['type'] ?? '') === 'text') {
				$text[] = $block['text'] ?? '';
			}
		}

		return ['text' => implode("\n", $text), 'is_error' => ($result['isError'] ?? false) === true];
	}

	/**
	 * The body of a response, in plain JSON or as server-sent events.
	 */
	public static function parseBody(string $body): array {
		$body = trim($body);

		if ($body !== '' && $body[0] !== '{') {
			$last = null;

			foreach (preg_split('/\r?\n/', $body) as $line) {
				if (strncmp($line, 'data:', 5) === 0) {
					$last = trim(substr($line, 5));
				}
			}

			$body = $last ?? '';
		}

		$decoded = json_decode($body, true);

		if (!is_array($decoded)) {
			throw new RuntimeException(I18n::t('The MCP server sent an invalid response.'));
		}

		return $decoded;
	}

	private function request(string $method, array $params = []): array {
		$curl = curl_init($this->url);

		$payload = ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method];

		if ($params) {
			$payload['params'] = $params;
		}

		curl_setopt_array($curl, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => json_encode($payload),
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_CONNECTTIMEOUT => 5,
			CURLOPT_TIMEOUT => 45,
			CURLOPT_HTTPHEADER => [
				'Authorization: Bearer '.$this->credential,
				'Content-Type: application/json',
				'Accept: application/json, text/event-stream'
			]
		]);

		$body = curl_exec($curl);
		$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
		$error = curl_error($curl);

		if ($body === false) {
			throw new RuntimeException(I18n::t('Cannot reach the MCP server').': '.$error);
		}

		if ($status !== 200) {
			throw new RuntimeException(I18n::t('Cannot reach the MCP server').': HTTP '.$status);
		}

		$decoded = self::parseBody($body);

		if (array_key_exists('error', $decoded)) {
			throw new RuntimeException($decoded['error']['message'] ?? I18n::t('The MCP server returned an error.'));
		}

		return $decoded['result'] ?? [];
	}
}
