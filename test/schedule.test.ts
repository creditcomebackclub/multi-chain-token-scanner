import test from 'node:test';import assert from 'node:assert/strict';import {schedule} from '../src/schedule.js';
test('discovery starts halfway between chart cycles and repeats at the same phase',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:0});const starts:number[]=[];const stop=schedule(()=>starts.push(Date.now()),900000,150000);
 t.mock.timers.tick(149999);assert.deepEqual(starts,[]);t.mock.timers.tick(1);assert.deepEqual(starts,[150000]);t.mock.timers.tick(900000);assert.deepEqual(starts,[150000,1050000]);stop();t.mock.timers.tick(900000);assert.equal(starts.length,2);
});
test('shutdown before delayed startup does not launch evaluation',t=>{t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0;const stop=schedule(()=>calls++,900000,150000);stop();t.mock.timers.tick(2000000);assert.equal(calls,0)});
