import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createQaMcpServer} from '../src/mcp-server.ts';

test('MCP stopping an absent owner never loads an optional driver', async () => {
  let attempts=0;
  const adapters=new Proxy({}, {get(){attempts++;throw new Error('driver must not load');}});
  const server=createQaMcpServer({adapters});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'stop-no-driver-test',version:'1'});
  await server.connect(st);await client.connect(ct);
  try {
    for(const args of [{},{owner:'absent'},{owner:'absent'}]){
      const result=await client.callTool({name:'qa_session_stop',arguments:args});
      const body=JSON.parse(result.content.find(c=>c.type==='text').text);
      assert.deepEqual(body,{stopped:false,reason:'not-running'});
    }
    assert.equal(attempts,0);
    const failed=await client.callTool({name:'qa_session_start',arguments:{owner:'failed-load',driver:'browser'}});
    assert.equal(JSON.parse(failed.content.find(c=>c.type==='text').text).ok,false);
    assert.equal(attempts,1);
    const cleanup=await client.callTool({name:'qa_session_stop',arguments:{owner:'failed-load'}});
    assert.deepEqual(JSON.parse(cleanup.content.find(c=>c.type==='text').text),{stopped:false,reason:'not-running'});
    assert.equal(attempts,1,'cleanup after failed start must not reload the driver');
    const invalid=await client.callTool({name:'qa_session_stop',arguments:{owner:' '}});
    assert.equal(JSON.parse(invalid.content.find(c=>c.type==='text').text).ok,false);
    assert.equal(attempts,1);
  }finally{await client.close();await server.close();}
});
