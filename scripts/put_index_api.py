#!/usr/bin/env python3
import base64
import json
import os
import urllib.request

with open('src/index.js', 'rb') as f:
    content = base64.b64encode(f.read()).decode()

sha = os.environ['SHA']
token = os.environ['GH_TOKEN']
repo = os.environ['GITHUB_REPOSITORY']

body = json.dumps({
    'message': 'feat(data): restore index + atomic multi-file publish after notify',
    'content': content,
    'sha': sha,
    'branch': 'main',
}).encode()

req = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/src/index.js',
    data=body,
    method='PUT',
    headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    },
)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)
    print('ok', data.get('content', {}).get('path'), data.get('commit', {}).get('sha'))
