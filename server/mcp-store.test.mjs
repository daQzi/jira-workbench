import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpStore } from './mcp-store.mjs';

describe('MCP 持久化与未知结果',()=>{
 it('规范化输入幂等、同 ID 不同输入拒绝、结果未知步骤重启后冻结',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'mcp-store-'));
  let s=createMcpStore(dir);
  try {
   const op=s.begin('agent','request','create',{b:2,a:1});
   expect(s.begin('agent','request','create',{a:1,b:2}).id).toBe(op.id);
   expect(()=>s.begin('agent','request','create',{a:3})).toThrow('相同 requestId');
   s.saveStep(op.id,'create',{state:'in_flight'});
   s.close();s=createMcpStore(dir);
   expect(s.step(op.id,'create').state).toBe('unknown');
   expect(s.step(op.id,'create').code).toBe('UNKNOWN_OUTCOME');
   expect(s.begin('another','request','create',{b:2,a:1}).id).not.toBe(op.id);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
 });
});
