<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData,
	CWebUser;

use Modules\ZabbixAgent\Includes\{
	I18n,
	Settings
};

/**
 * The chat page.
 */
class View extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function checkPermissions(): bool {
		return CWebUser::isLoggedIn() && !CWebUser::isGuest();
	}

	protected function doAction(): void {
		$settings = Settings::get();

		$this->setResponse(new CControllerResponseData([
			'title' => I18n::t('AI agent'),
			'config' => [
				'userid' => CWebUser::$data['userid'],
				'username' => CWebUser::$data['username'],
				'is_admin' => $this->getUserType() == USER_TYPE_SUPER_ADMIN,
				'providers' => array_map(static fn(array $p): array => [
					'id' => $p['id'], 'name' => $p['name'], 'model' => $p['model']
				], $settings['providers']),
				'default_provider' => $settings['default_provider'],
				'max_steps' => (int) $settings['max_steps'],
				'context_tokens' => (int) $settings['context_tokens'],
				'lang' => I18n::catalog(),
				'tokens' => [
					'chat' => \CCsrfTokenHelper::get('agent.chat'),
					'tool' => \CCsrfTokenHelper::get('agent.tool'),
					'tools' => \CCsrfTokenHelper::get('agent.tools')
				],
				'csrf_name' => CSRF_TOKEN_NAME
			]
		]));
	}
}
