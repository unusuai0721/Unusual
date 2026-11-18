import test from 'node:test';
import assert from 'node:assert/strict';
import {CommentSchedule} from '../app/lib/comment-schedule.mjs';
test('idle polls back off; activity and settings changes restore responsiveness',()=>{const s=new CommentSchedule();assert.ok(s.due(0,1));assert.equal(s.complete(0,{}).intervalMinutes,4);assert.equal(s.due(1000,1),false);assert.equal(s.complete(240000,{}).intervalMinutes,8);assert.equal(s.complete(720000,{}).intervalMinutes,15);assert.equal(s.complete(1620000,{newComments:1}).intervalMinutes,2);assert.ok(s.due(1620001,2));});
test('failures back off up to 30 minutes and recover',()=>{const s=new CommentSchedule();for(let i=0;i<10;i++)s.complete(0,null,true);assert.equal(s.nextAt,30*60000);assert.equal(s.complete(0,{newComments:1}).intervalMinutes,2);});
