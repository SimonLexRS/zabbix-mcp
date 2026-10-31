<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData,
	CWebUser;

use Modules\ZabbixAgent\Includes\{
	McpClient,
	Settings
};

use Throwable;

/**
 * The tools of the MCP server available to the current user, marked as read-only or not.
 */
class Tools extends CController {

	protected function checkInput(): bool {
		return true;
	}

	protected function checkPermissions(): bool {
		return CWebUser::isLoggedIn() && !CWebUser::isGuest();
	}

	protected function doAction(): void {
		try {
			$tools = (new McpClient(Settings::get()['mcp_url'], CWebUser::$data['sessionid']))->listTools();

			$output = ['tools' => array_map(static fn(array $tool): array => [
				'name' => $tool['name'],
				'title' => $tool['annotations']['title'] ?? $tool['name'],
				'read_only' => McpClient::isReadOnly($tool),
				'destructive' => ($tool['annotations']['destructiveHint'] ?? false) === true
			], $tools)];
		}
		catch (Throwable $exception) {
			$output = ['error' => $exception->getMessage()];
		}

		$this->setResponse((new CControllerResponseData(['main_block' => json_encode($output)]))->disableView());
	}
}
