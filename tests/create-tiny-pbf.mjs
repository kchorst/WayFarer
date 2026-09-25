import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const out=process.argv[2]
if(!out)throw new Error('Output .osm.pbf path is required.')
function varint(number){let value=BigInt(number),bytes=[];do{let byte=Number(value&0x7fn);value>>=7n;if(value)byte|=0x80;bytes.push(byte)}while(value);return Buffer.from(bytes)}
function zigzag(number){const value=BigInt(number);return(value<<1n)^(value>>63n)}
function tag(field,wire){return varint((field<<3)|wire)}
function fieldVarint(field,value){return Buffer.concat([tag(field,0),varint(value)])}
function fieldSint(field,value){return Buffer.concat([tag(field,0),varint(zigzag(value))])}
function fieldBytes(field,value){return Buffer.concat([tag(field,2),varint(value.length),value])}
function packed(values,signed=false){return Buffer.concat(values.map(value=>varint(signed?zigzag(value):value)))}
function stringTable(values){return Buffer.concat(values.map(value=>fieldBytes(1,Buffer.from(value))))}
function blob(raw){return fieldBytes(3,zlib.deflateSync(raw))}
function block(type,raw){const body=blob(raw),header=Buffer.concat([fieldBytes(1,Buffer.from(type)),fieldVarint(3,body.length)]),length=Buffer.alloc(4);length.writeUInt32BE(header.length);return Buffer.concat([length,header,body])}
function tinyPbf(){
  const strings=['','highway','primary','place','city','name','Kingston']
  const dense=Buffer.concat([fieldBytes(1,packed([1,1,1],true)),fieldBytes(8,packed([180000000,5000,5000],true)),fieldBytes(9,packed([-768000000,5000,5000],true)),fieldBytes(10,packed([3,4,5,6,0,0,0]))])
  const way=Buffer.concat([fieldVarint(1,10),fieldBytes(2,packed([1])),fieldBytes(3,packed([2])),fieldBytes(8,packed([1,1,1],true))])
  const primitiveGroup=Buffer.concat([fieldBytes(2,dense),fieldBytes(3,way)]),primitiveBlock=Buffer.concat([fieldBytes(1,stringTable(strings)),fieldBytes(2,primitiveGroup)])
  const bbox=Buffer.concat([fieldSint(1,-77000000000),fieldSint(2,-76000000000),fieldSint(3,19000000000),fieldSint(4,17000000000)])
  return Buffer.concat([block('OSMHeader',fieldBytes(1,bbox)),block('OSMData',primitiveBlock)])
}
fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,tinyPbf())
console.log(path.resolve(out))
