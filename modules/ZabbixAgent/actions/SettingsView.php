<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData;

use Modules\ZabbixAgent\Includes\{
	I18n,
	Settings
};

/**
 * Settings page: providers and the connection with the MCP server. Super admins only.
 */
class SettingsView extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		$this->setResponse(new CControllerResponseData([
			'title' => I18n::t('AI agent settings'),
			'config' => [
				'settings' => Settings::forBrowser(Settings::get()),
				'lang' => I18n::catalog(),
				'tokens' => [
					'save' => \CCsrfTokenHelper::get('agent.settings.update'),
					'test' => \CCsrfTokenHelper::get('agent.provider.test')
				],
				'csrf_name' => CSRF_TOKEN_NAME
			]
		]));
	}
}
