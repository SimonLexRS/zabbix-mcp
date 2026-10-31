#!/usr/bin/env python3
"""Register and enable the AI agent module through the Zabbix API. Safe to run again.

  export ZABBIX_URL=http://zabbix.example.com ZABBIX_API_TOKEN=...   # token of a Super admin
  python3 scripts/enable-module.py
"""

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    url, token = os.environ.get('ZABBIX_URL'), os.environ.get('ZABBIX_API_TOKEN')

    if not url or not token:
        print('Set ZABBIX_URL and ZABBIX_API_TOKEN.', file=sys.stderr)
        return 2

    def call(method: str, params):
        body = json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}).encode()
        headers = {'Content-Type': 'application/json-rpc', 'Authorization': 'Bearer ' + token}
        request = urllib.request.Request(url.rstrip('/') + '/api_jsonrpc.php', body, headers)

        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)

        if 'error' in result:
            raise SystemExit(f'{method}: {result["error"].get("data") or result["error"].get("message")}')

        return result['result']

    try:
        existing = call('module.get', {'output': ['moduleid'], 'filter': {'id': ['zabbixagent']}})

        if existing:
            call('module.update', {'moduleid': existing[0]['moduleid'], 'status': 1})
        else:
            call('module.create', {'id': 'zabbixagent', 'relative_path': 'modules/ZabbixAgent', 'status': 1})
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise SystemExit(f'Cannot reach the Zabbix API: {error}')

    print('ZabbixAgent: enabled')

    return 0


if __name__ == '__main__':
    sys.exit(main())
