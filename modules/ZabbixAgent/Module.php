<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent;

use APP,
	CMenuItem,
	CWebUser;

use Modules\ZabbixAgent\Includes\I18n;

use Zabbix\Core\CModule;

class Module extends CModule {

	public function init(): void {
		if (!CWebUser::isLoggedIn()) {
			return;
		}

		$monitoring = APP::Component()->get('menu.main')->find(_('Monitoring'));

		if ($monitoring !== null && $monitoring->hasSubMenu()) {
			$monitoring->getSubMenu()->add((new CMenuItem(I18n::t('AI agent')))->setAction('agent.view'));
		}
	}
}
