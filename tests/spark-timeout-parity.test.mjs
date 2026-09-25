import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8')
test('15-second Spark responsiveness target never owns the parent cancellation signal',()=>{
  assert.doesNotMatch(app,/createDeadline\(deadline\.signal,\{ms:14500,label:'First useful Spark route skeleton'\}\)/)
  assert.match(app,/generateSparkFromContract\(e\.prompt,provisional,\{signal:deadline\.signal,firstIdeaTargetMs:8500,targetCount:1/)
  assert.match(app,/generateSparkFromContract\(e\.prompt,contract,\{\.\.\.hooks,signal:deadline\.signal,firstIdeaTargetMs:8500,targetCount:1/)
})
test('desktop Spark confirmation is beside the request rather than forced below it',()=>{
  assert.match(css,/#sparkComposer:has\(#tripBasicsPanel:not\(\[hidden\]\)\)\{display:grid/)
  assert.match(css,/>#tripBasicsPanel\{grid-column:2/)
})
