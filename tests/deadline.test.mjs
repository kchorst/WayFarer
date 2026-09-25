import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeadline, deadlineMessage, INTERACTIVE_LIMIT_MS } from '../public/core/deadline.js'

test('interactive performance contract is a 120-second hard ceiling',()=>{assert.equal(INTERACTIVE_LIMIT_MS,120000)})
test('deadline aborts bounded work with an explicit timeout reason',async()=>{const d=createDeadline(null,{ms:15,label:'Test action'});try{await new Promise(resolve=>setTimeout(resolve,30));assert.equal(d.signal.aborted,true);assert.equal(d.signal.reason?.name,'TimeoutError');assert.match(deadlineMessage(d.signal.reason,'Test action'),/2-minute limit/i)}finally{d.dispose()}})
