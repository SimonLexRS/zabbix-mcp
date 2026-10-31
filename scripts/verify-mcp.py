#!/usr/bin/env python3
"""Check the native Zabbix MCP server: lists its tools and makes one real read. Read-only.

  export MCP_URL=http://127.0.0.1:8443/mcp ZABBIX_API_TOKEN=...
  python3 scripts/verify-mcp.py

Exit code: 0 when both checks pass.
"""

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    url = os.environ.get('MCP_URL', 'http://127.0.0.1:8443/mcp')
    token = os.environ.get('ZABBIX_API_TOKEN')

    if not token:
        print('Set ZABBIX_API_TOKEN.', file=sys.stderr)
        return 2

    def call(method: str, params=None):
        payload = {'jsonrpc': '2.0', 'id': 1, 'method': method}

        if params is not None:
            payload['params'] = params

        request = urllib.request.Request(url, json.dumps(payload).encode(), {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        })

        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode()

        if not text.lstrip().startswith('{'):
            text = [line[5:] for line in text.splitlines() if line.startswith('data:')][-1]

        return json.loads(text)

    try:
        tools = call('tools/list')['result']['tools']
    except urllib.error.HTTPError as error:
        print(f'FAIL tools/list: HTTP {error.code}')
        print({400: 'The Accept header is wrong.', 401: 'The token is missing.',
            403: 'This address is not in AllowedIP.'}.get(error.code, ''))
        return 1
    except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
        print(f'FAIL tools/list: {error}')
        return 1

    reads = [t['name'] for t in tools if t.get('annotations', {}).get('readOnlyHint')]
    changes = [t['name'] for t in tools if t['name'] not in reads]
    print(f'OK   {len(tools)} tools: {len(reads)} read, {len(changes)} change')

    answer = call('tools/call', {'name': 'hostgroup_get', 'arguments': {'limit': 1}}) \
        if 'hostgroup_get' in reads else None

    if answer is None:
        print('INFO hostgroup_get is disabled: the real read was skipped')
    elif answer.get('result', {}).get('isError') or 'error' in answer:
        print(f'FAIL read through Zabbix: {json.dumps(answer)[:300]}')
        return 1
    else:
        print('OK   real read through the Zabbix API (hostgroup_get)')

    print('---- MCP server is working')

    return 0


if __name__ == '__main__':
    sys.exit(main())
