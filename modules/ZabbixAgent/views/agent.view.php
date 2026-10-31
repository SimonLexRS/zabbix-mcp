<?php declare(strict_types = 0);

/**
 * The chat page; assets/js/agent.js builds the interface.
 *
 * @var CView $this
 * @var array $data
 */

use Modules\ZabbixAgent\Includes\I18n;

$html_page = (new CHtmlPage())->setTitle($data['title']);

if ($data['config']['is_admin']) {
	$html_page->setControls((new CTag('nav', true, (new CList())->addItem(
		(new CLink(I18n::t('Settings'), (new CUrl('zabbix.php'))->setArgument('action', 'agent.settings')))
			->addClass(ZBX_STYLE_BTN_ALT)
	))));
}

$html_page->addItem(
	(new CDiv())
		->setId('zbxagent')
		->setAttribute('data-config', json_encode($data['config']))
)->show();
