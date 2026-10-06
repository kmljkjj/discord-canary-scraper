from pathlib import Path
p = Path('scripts/build_quest_v2_snippet.js')
t = p.read_text()
t2 = t.replace("+ '`;", "+ '`';")
if t2 == t:
    # try other quote forms
    t2 = t.replace("+ '`\n", "FIXED")
    raise SystemExit('pattern not found')
p.write_text(t2)
print('fixed')
