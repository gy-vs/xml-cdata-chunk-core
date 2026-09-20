export type QName={prefix:string;local:string;uri:string};
export class NamespaceStack{#frames:Record<string,string>[]=[{}];start(declarations:Record<string,string>){this.#frames.push({...this.#frames.at(-1),...declarations})}end(){if(this.#frames.length>1)this.#frames.pop()}resolve(name:string,attribute=false):QName{const [prefix='',local=name]=name.includes(':')?name.split(':',2):['',name];const uri=this.#frames.at(-1)?.[prefix]??'';return {prefix,local,uri:attribute?uri:uri}}}

export type XmlErrorCode=
  |'cdata-end-in-text'
  |'unclosed-cdata'
  |'unexpected-eof'
  |'invalid-lt'
  |'unknown-markup'
  |'malformed-tag'
  |'malformed-pi'
  |'mismatched-end-tag'
  |'unclosed-element'
  |'truncated-utf8'
  |'hyphens-in-comment';

export type XmlEvent=
  |{type:'text';data:string;cdata:boolean}
  |{type:'start';name:string;qname:QName;attributes:Record<string,string>}
  |{type:'end';name:string;qname:QName}
  |{type:'comment';data:string}
  |{type:'pi';target:string;data:string}
  |{type:'error';code:XmlErrorCode;message:string};

enum State{Text,TagOpen,Markup,StartTag,EndTag,Comment,Pi,CData,Bogus}
enum TagState{Name,PreAttr,AttrName,PreEq,PreVal,Val,PostVal,Slash}

const isWs=(c:string)=>c===' '||c==='\t'||c==='\n'||c==='\r';
const isNameStart=(c:string)=>c>='\u0080'||(c>='A'&&c<='Z')||(c>='a'&&c<='z')||c==='_'||c===':';
const isName=(c:string)=>isNameStart(c)||(c>='0'&&c<='9')||c==='-'||c==='.';

/**
 * Incremental streaming XML tokenizer. Feed input with write() (string or
 * Uint8Array; UTF-8 sequences may be split across chunks) and finish with
 * end(). Both return the events produced by that call. Parse problems are
 * reported as recoverable error events; the parser keeps going after them.
 */
export class StreamParser{
  #state:State=State.Text;
  #decoder=new TextDecoder();
  #started=false;
  #ended=false;
  #out:XmlEvent[]=[];
  // Pending regular character data, flushed only at markup boundaries so a
  // ']]>' split across chunks is still detected as one piece.
  #text='';
  // CDATA section state. #cdata is the section content collected so far and
  // #close is the length of the shortest suffix that can still grow into the
  // ']]>' terminator (0, 1 or 2). Only a complete match ends the section; a
  // failed candidate is handed back to the content in its original order.
  #cdata='';
  #close:0|1|2=0;
  #markup='';
  #comment='';
  #dashes=0;
  #piTarget='';
  #piData='';
  #piInData=false;
  #piQ=false;
  #tagState:TagState=TagState.Name;
  #tagName='';
  #attrs:Record<string,string>={};
  #attrName='';
  #attrValue='';
  #quote='';
  #endName='';
  #elements:string[]=[];
  #qnames:QName[]=[];
  #ns=new NamespaceStack();

  write(chunk:string|Uint8Array):XmlEvent[]{
    if(this.#ended)throw new Error('StreamParser: write() after end()');
    let s=typeof chunk==='string'?chunk:this.#decoder.decode(chunk,{stream:true});
    this.#out=[];
    if(!this.#started&&s){this.#started=true;if(s.charCodeAt(0)===0xfeff)s=s.slice(1)}
    for(const ch of s)this.#step(ch);
    return this.#out;
  }

  end():XmlEvent[]{
    if(this.#ended)return [];
    this.#ended=true;
    this.#out=[];
    const tail=this.#decoder.decode();
    if(tail){for(const ch of tail)this.#step(ch);this.#error('truncated-utf8','input ends with an incomplete UTF-8 sequence')}
    switch(this.#state){
      case State.Text:break;
      case State.TagOpen:
        this.#error('unexpected-eof',"input ends after '<'");
        this.#text+='<';this.#state=State.Text;break;
      case State.CData:{
        // EOF inside a section: the held terminator candidate is content.
        if(this.#close){this.#cdata+=']'.repeat(this.#close);this.#close=0}
        this.#out.push({type:'text',data:this.#cdata,cdata:true});this.#cdata='';
        this.#error('unclosed-cdata',"CDATA section is not closed by ']]>'");this.#state=State.Text;break;
      }
      case State.Markup:this.#error('unexpected-eof',`input ends inside '<!${this.#markup}'`);break;
      case State.Comment:this.#error('unexpected-eof',"comment is not closed by '-->'");break;
      case State.Pi:this.#error('unexpected-eof',"processing instruction is not closed by '?>'");break;
      case State.StartTag:this.#error('unexpected-eof',`start tag <${this.#tagName} is not closed by '>'`);break;
      case State.EndTag:this.#error('unexpected-eof',`end tag </${this.#endName} is not closed by '>'`);break;
      case State.Bogus:this.#error('unexpected-eof',"markup declaration is not closed by '>'");break;
    }
    this.#flushText();
    while(this.#elements.length){
      this.#error('unclosed-element',`element <${this.#elements.at(-1)}> is never closed`);
      this.#closeElement();
    }
    return this.#out;
  }

  #step(ch:string){
    switch(this.#state){
      case State.Text:
        if(ch==='<'){this.#flushText();this.#state=State.TagOpen}
        else{
          this.#text+=ch;
          if(ch==='>'&&this.#text.endsWith(']]>'))this.#error('cdata-end-in-text',"']]>' is not allowed in character data");
        }
        break;
      case State.TagOpen:
        if(ch==='/'){this.#endName='';this.#state=State.EndTag}
        else if(ch==='?'){this.#piTarget='';this.#piData='';this.#piInData=false;this.#piQ=false;this.#state=State.Pi}
        else if(ch==='!'){this.#markup='';this.#state=State.Markup}
        else if(isNameStart(ch)){this.#tagName=ch;this.#attrs={};this.#attrName='';this.#attrValue='';this.#quote='';this.#tagState=TagState.Name;this.#state=State.StartTag}
        else{this.#error('invalid-lt',`'<' must start markup, not ${JSON.stringify(ch)}`);this.#text+='<';this.#state=State.Text;this.#step(ch)}
        break;
      case State.Markup:{
        this.#markup+=ch;
        if('--'.startsWith(this.#markup)||'[CDATA['.startsWith(this.#markup)){
          if(this.#markup==='--'){this.#comment='';this.#dashes=0;this.#state=State.Comment}
          else if(this.#markup==='[CDATA['){this.#flushText();this.#cdata='';this.#close=0;this.#state=State.CData}
        }else{
          this.#error('unknown-markup',`unrecognized markup declaration '<!${this.#markup}'`);
          this.#state=ch==='>'?State.Text:State.Bogus;
        }
        break;
      }
      case State.CData:
        if(this.#close===0){if(ch===']')this.#close=1;else this.#cdata+=ch}
        else if(this.#close===1){
          if(ch===']')this.#close=2;
          else{this.#cdata+=']'+ch;this.#close=0}
        }else{
          if(ch==='>'){this.#out.push({type:'text',data:this.#cdata,cdata:true});this.#cdata='';this.#close=0;this.#state=State.Text}
          else if(ch===']')this.#cdata+=']';// oldest ']' can never join a terminator; the newest ']]' stays a live candidate
          else{this.#cdata+=']]'+ch;this.#close=0}
        }
        break;
      case State.Comment:
        if(this.#dashes===2){
          if(ch==='>'){this.#out.push({type:'comment',data:this.#comment});this.#comment='';this.#dashes=0;this.#state=State.Text}
          else{this.#error('hyphens-in-comment',"'--' is not allowed inside a comment");this.#comment+='--';this.#dashes=0;this.#step(ch)}
        }else if(ch==='-')this.#dashes++;
        else{if(this.#dashes){this.#comment+='-';this.#dashes=0}this.#comment+=ch}
        break;
      case State.Pi:
        if(!this.#piInData){
          if(isWs(ch)){if(this.#piTarget)this.#piInData=true;else this.#error('malformed-pi','processing instruction has no target')}
          else if(ch==='?'){if(!this.#piTarget)this.#error('malformed-pi','processing instruction has no target');this.#piInData=true;this.#piQ=true}
          else this.#piTarget+=ch;
        }else if(this.#piQ){
          if(ch==='>'){this.#out.push({type:'pi',target:this.#piTarget,data:this.#piData});this.#piTarget='';this.#piData='';this.#piInData=false;this.#piQ=false;this.#state=State.Text}
          else{this.#piData+='?';this.#piQ=false;if(ch==='?')this.#piQ=true;else this.#piData+=ch}
        }else if(ch==='?')this.#piQ=true;
        else this.#piData+=ch;
        break;
      case State.StartTag:this.#stepTag(ch);break;
      case State.EndTag:
        if(ch==='>')this.#completeEndTag();
        else if(isWs(ch)){/* whitespace around the name is tolerated */}
        else if(isName(ch))this.#endName+=ch;
        else this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} in end tag`);
        break;
      case State.Bogus:if(ch==='>')this.#state=State.Text;break;
    }
  }

  #stepTag(ch:string){
    switch(this.#tagState){
      case TagState.Name:
        if(isName(ch))this.#tagName+=ch;
        else if(isWs(ch))this.#tagState=TagState.PreAttr;
        else if(ch==='/')this.#tagState=TagState.Slash;
        else if(ch==='>')this.#completeStartTag(false);
        else this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} in start tag`);
        break;
      case TagState.PreAttr:
        if(isWs(ch)){}
        else if(isNameStart(ch)){this.#attrName=ch;this.#tagState=TagState.AttrName}
        else if(ch==='/')this.#tagState=TagState.Slash;
        else if(ch==='>')this.#completeStartTag(false);
        else this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} in start tag`);
        break;
      case TagState.AttrName:
        if(isName(ch))this.#attrName+=ch;
        else if(isWs(ch))this.#tagState=TagState.PreEq;
        else if(ch==='='){this.#attrValue='';this.#tagState=TagState.PreVal}
        else{this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} after attribute name`);this.#tagRecover(ch)}
        break;
      case TagState.PreEq:
        if(isWs(ch)){}
        else if(ch==='='){this.#attrValue='';this.#tagState=TagState.PreVal}
        else{this.#error('malformed-tag',"expected '=' after attribute name");this.#tagRecover(ch)}
        break;
      case TagState.PreVal:
        if(isWs(ch)){}
        else if(ch==='"'||ch==="'"){this.#quote=ch;this.#tagState=TagState.Val}
        else{this.#error('malformed-tag','attribute value must be quoted');this.#tagRecover(ch)}
        break;
      case TagState.Val:
        if(ch===this.#quote){this.#attrs[this.#attrName]=this.#attrValue;this.#attrName='';this.#tagState=TagState.PostVal}
        else this.#attrValue+=ch;
        break;
      case TagState.PostVal:
        if(isWs(ch))this.#tagState=TagState.PreAttr;
        else if(ch==='/')this.#tagState=TagState.Slash;
        else if(ch==='>')this.#completeStartTag(false);
        else{this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} after attribute value`);this.#tagRecover(ch)}
        break;
      case TagState.Slash:
        if(ch==='>')this.#completeStartTag(true);
        else{this.#error('malformed-tag',`unexpected ${JSON.stringify(ch)} after '/'`);this.#tagRecover(ch)}
        break;
    }
  }

  #tagRecover(ch:string){
    if(this.#attrName){if(!(this.#attrName in this.#attrs))this.#attrs[this.#attrName]='';this.#attrName=''}
    this.#tagState=TagState.PreAttr;
    this.#stepTag(ch);
  }

  #completeStartTag(selfClosing:boolean){
    if(this.#attrName){if(!(this.#attrName in this.#attrs))this.#attrs[this.#attrName]='';this.#attrName=''}
    const name=this.#tagName,attributes=this.#attrs;
    const declarations:Record<string,string>={};
    for(const k of Object.keys(attributes)){
      if(k==='xmlns')declarations['']=attributes[k];
      else if(k.startsWith('xmlns:'))declarations[k.slice(6)]=attributes[k];
    }
    this.#ns.start(declarations);
    const qname=this.#ns.resolve(name);
    this.#out.push({type:'start',name,qname,attributes});
    this.#elements.push(name);this.#qnames.push(qname);
    if(selfClosing)this.#closeElement();
    this.#tagName='';this.#attrs={};this.#tagState=TagState.Name;this.#state=State.Text;
  }

  #completeEndTag(){
    const name=this.#endName;this.#endName='';this.#state=State.Text;
    const i=this.#elements.lastIndexOf(name);
    if(i===-1){this.#error('mismatched-end-tag',`end tag </${name}> has no matching start tag`);return}
    if(i!==this.#elements.length-1)this.#error('mismatched-end-tag',`end tag </${name}> does not match <${this.#elements.at(-1)}>`);
    while(this.#elements.length>i)this.#closeElement();
  }

  #closeElement(){
    const name=this.#elements.pop()!,qname=this.#qnames.pop()!;
    this.#out.push({type:'end',name,qname});
    this.#ns.end();
  }

  #flushText(){
    if(this.#text){this.#out.push({type:'text',data:this.#text,cdata:false});this.#text=''}
  }

  #error(code:XmlErrorCode,message:string){
    this.#out.push({type:'error',code,message});
  }
}
