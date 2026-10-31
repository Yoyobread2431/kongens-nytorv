#!/bin/sh
# Publish to GitHub Pages: stamp a new version on the script tags, commit, push.
# GitHub Pages lets browsers keep files for 10 minutes; the ?v= stamp makes a browser load either all-old or
# all-new files, never a mix (a new page with old code, or the other way round, can break every button).
# Usage: ./publish.sh "What changed"
set -e
cd "$(dirname "$0")"
v=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s#(src=\"(logic|store|app|online/config|online/store-online)\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#g" index.html
git add -A
git commit -q -m "${1:-Update}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q
echo "Published version $v. GitHub Pages is live in about a minute."
