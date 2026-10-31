<?php declare(strict_types = 0);

/**
 * The settings page; assets/js/agent.js builds the form.
 *
 * @var CView $this
 * @var array $data
 */

use Modules\ZabbixAgent\Includes\I18n;

(new CHtmlPage())
	->setTitle($data['title'])
	->setControls((new CTag('nav', true, (new CList())->addItem(
		(new CLink(I18n::t('Back to the chat'), (new CUrl('zabbix.php'))->setArgument('action', 'agent.view')))
			->addClass(ZBX_STYLE_BTN_ALT)
	))))
	->addItem(
		(new CDiv())
			->setId('zbxagent-settings')
			->setAttribute('data-config', json_encode($data['config']))
	)
	->show();
