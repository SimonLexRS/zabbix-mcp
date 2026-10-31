<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData,
	CWebUser;

use Modules\ZabbixAgent\Includes\{
	I18n,
	McpClient,
	Settings
};

use Throwable;

/**
 * Runs one tool of the MCP server. The MCP server applies changes without asking unless its client supports elicitation,
 * so the approval is enforced here: a tool that is not declared read-only needs "approved", and never runs in plan mode.
 */
class ToolCall extends CController {

	protected function checkInput(): bool {
		return $this->validateInput(['payload' => 'required|string']);
	}

	protected function checkPermissions(): bool {
		return CWebUser::isLoggedIn() && !CWebUser::isGuest();
	}

	protected function doAction(): void {
		$started = microtime(true);

		try {
			$payload = json_decode($this->getInput('payload'), true);
			$name = (string) ($payload['name'] ?? '');
			$arguments = is_array($payload['arguments'] ?? null) ? $payload['arguments'] : [];

			$client = new McpClient(Settings::get()['mcp_url'], CWebUser::$data['sessionid']);
			$tool = null;

			foreach ($client->listTools() as $candidate) {
				if ($candidate['name'] === $name) {
					$tool = $candidate;
					break;
				}
			}

			if ($tool === null) {
				$output = ['text' => I18n::t('This tool does not exist or is not enabled.'), 'is_error' => true];
			}
			elseif (!McpClient::isReadOnly($tool) && ($payload['mode'] ?? '') === 'plan') {
				$output = ['text' => I18n::t('Plan mode only allows read tools.'), 'is_error' => true];
			}
			elseif (!McpClient::isReadOnly($tool) && ($payload['approved'] ?? false) !== true) {
				$output = ['text' => I18n::t('This change was not approved by the user.'), 'is_error' => true];
			}
			else {
				$output = $client->callTool($name, $arguments);
			}
		}
		catch (Throwable $exception) {
			$output = ['text' => $exception->getMessage(), 'is_error' => true];
		}

		$output['ms'] = (int) round((microtime(true) - $started) * 1000);

		$this->setResponse((new CControllerResponseData(['main_block' => json_encode($output)]))->disableView());
	}
}
