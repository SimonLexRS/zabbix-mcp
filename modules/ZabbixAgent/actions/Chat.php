<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CWebUser;

use Modules\ZabbixAgent\Includes\{
	Crypto,
	I18n,
	Llm,
	McpClient,
	Prompt,
	Settings
};

use Throwable;

/**
 * One turn of the model, streamed to the browser as server-sent events: reasoning, text, then the final message.
 * The browser runs the tools and asks for the next turn; the key of the provider stays here.
 */
class Chat extends CController {

	protected function checkInput(): bool {
		return $this->validateInput(['payload' => 'required|string']);
	}

	protected function checkPermissions(): bool {
		return CWebUser::isLoggedIn() && !CWebUser::isGuest();
	}

	protected function doAction(): void {
		@set_time_limit(0);

		// The stream outlives the headers: the session has to save its cookie before the first byte.
		session_write_close();

		while (ob_get_level() > 0) {
			ob_end_clean();
		}

		header('Content-Type: text/event-stream; charset=utf-8');
		header('Cache-Control: no-store');
		header('X-Accel-Buffering: no');

		$send = static function (string $type, $value): void {
			echo 'data: ', json_encode(['t' => $type, 'v' => $value], JSON_UNESCAPED_UNICODE), "\n\n";
			flush();
		};

		try {
			$payload = json_decode($this->getInput('payload'), true);

			if (!is_array($payload) || !is_array($payload['messages'] ?? null)) {
				throw new \InvalidArgumentException(I18n::t('Invalid request.'));
			}

			$settings = Settings::get();
			$provider = Settings::provider($settings, (string) ($payload['provider'] ?? ''));

			if ($provider === null) {
				throw new \InvalidArgumentException(I18n::t('There is no such provider.'));
			}

			$key = ($provider['key'] ?? '') !== '' ? Crypto::decrypt($provider['key']) : '';
			$mode = (string) ($payload['mode'] ?? 'ask');

			if (($payload['purpose'] ?? '') === 'summary') {
				$system = Prompt::SUMMARY;
				$tools = [];
			}
			else {
				$system = Prompt::build($mode, $settings['instructions'], CWebUser::$data['username'], time());
				$tools = $this->tools($settings, $mode, $payload['local_tools'] ?? []);
			}

			$result = Llm::stream($provider, $key, $system, $payload['messages'], $tools, $send);

			$send('done', $result);
		}
		catch (Throwable $exception) {
			$send('error', $exception->getMessage());
		}

		exit;
	}

	/**
	 * The tools the model may use. In plan mode, the server itself leaves out whatever is not read-only.
	 */
	private function tools(array $settings, string $mode, array $local_tools): array {
		$tools = (new McpClient($settings['mcp_url'], CWebUser::$data['sessionid']))->listTools();

		if ($mode === 'plan') {
			$tools = array_values(array_filter($tools, [McpClient::class, 'isReadOnly']));
		}

		foreach ($local_tools as $tool) {
			if (isset($tool['name'], $tool['inputSchema'])) {
				$tools[] = $tool;
			}
		}

		return $tools;
	}
}
