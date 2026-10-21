import * as http from "node:http";
import * as fs from "node:fs";
const server=http.createServer((_request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8"});response.end("<!doctype html><html><head><title>PAGE_054b33599cac4ccfb3a758d71b184a98</title></head><body><p>PAGE_054b33599cac4ccfb3a758d71b184a98</p></body></html>");});
server.listen(0,"127.0.0.1",()=>{const url="http://127.0.0.1:"+server.address().port;fs.writeFileSync("service-runtime.json",JSON.stringify({pid:process.pid,url})+"\n",{mode:0o600});process.stdout.write("READY "+url+"\nSTDOUT_801856340ba848ac8cd9e07745f23322\n");process.stderr.write("STDERR_b2c4fea710c6494ca483612f72850c84\n");});
setTimeout(()=>server.close(()=>process.exit(0)),600000).unref();
