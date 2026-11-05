import re
p = 'src/lib/extract.js'
s = open(p).read()
s = s.replace('n\\.e\\(["\'](\\d+)["\']\\)/g', 'n\\.e\\(["\']?(\\d+)["\']?\\)/g', 1)
s = s.replace('en-US\\.json["\']\\s*:\\s*["\'](\\d+)["\']/g', 'en-US\\.json["\']\\s*:\\s*["\']?(\\d+)["\']?/g', 1)
i = s.index('function extractStrings(content, out) {'); j = s.index('function isValidRouteKey')
s = s[:i] + s[j:]
open(p, 'w').write(s)
p = 'src/index.js'
s = open(p).read()
s = s.replace("const crypto = require('crypto');\n", '', 1)
i = s.index('function stableObject(value) {'); j = s.index('function expFingerprint')
s = s[:i] + s[j:]
open(p, 'w').write(s)
