const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
// Run actual TypeScript modules and route handlers, with fake provider transport only.
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, ...args);
};
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (mod, filename) => {
  let source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(filename).href));
  if (filename.endsWith(path.join('resume-evaluator', 'page.tsx'))) source += '\nexport const testHooks = {parseCsv, rowsForExport, sheetRowsForExport, exportVersions, formatSubMarks, decisionBand};';
  mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
const { validateRules, validateGrade, reusableRules, resumeQueue, gradingPrompt, scoreLabel } = require('../lib/rubric.ts');
const { rubricVersion, rulesForRequest } = require('../lib/rubric-server.ts');
const prepare = require('../app/api/resume-evaluator/prepare-rubric/route.ts').POST;
const gradeRow = require('../app/api/resume-evaluator/grade-row/route.ts').POST;
const gradeFile = require('../app/api/resume-evaluator/grade/route.ts').POST;
const ui = require('../app/resume-evaluator/page.tsx').testHooks;
const { resumeLinkTargets } = require('../lib/resume-extraction.ts');
test('PDF contact labels retain link targets and reject executable annotation URLs',()=>{
  assert.deepEqual(resumeLinkTargets([{url:'mailto:candidate@example.com'},{url:'https://linkedin.com/in/candidate'},{unsafeUrl:'tel:+919999999999'},{url:'javascript:alert(1)'},{url:'file:///private'},{url:'https://linkedin.com/in/candidate'},{url:'https://bad\nvalue'},{url:7}]),['mailto:candidate@example.com','https://linkedin.com/in/candidate','tel:+919999999999']);
});
const clone = v => structuredClone(v);
function rules() {
  const sourceRubric = 'Experience /20 + skills /15 + ownership /5. Maximum 40. Missing evidence unknown. Manual review only.';
  return { schemaVersion: 1, sourceRubric, version: rubricVersion(sourceRubric), title: 'Test rubric', maxScore: 40,
    criteria: [['A',20],['B',15],['C',5]].map(([id,maxScore]) => ({ id, name: id, minScore: 0, maxScore, allowedScores: null, multiplier: 1, missingEvidence: 'unknown', zeroRequiresConfirmation: false, instructions: 'Use supplied candidate evidence.' })),
    instructions: 'Manual review only.', decisionBands: [], reviewRules: [], requiredDetails: [] };
}
function raw(scores = [15,10,5]) {
  return { scorable: true, name: '', phoneNumber: '', email: '', linkedInUrl: '', extraFields: {},
    subMarks: scores.map((score,i) => ({ id: ['A','B','C'][i], score, evidence: score === null ? '' : 'Built APIs', anchor: score === null ? 'Unknown' : 'Supported anchor', reason: 'Supported by the candidate record.', confirmedAbsent: false })),
    reviewChecks: [], details: {}, remarks: { strengths: [], weaknesses: [], selectedOrRejectedReason: 'For manual comparison.', missingEvidence: [], risks: [] }, summary: 'Candidate assessment.' };
}
test('40 point rubric yields 30/40, never a normalized 75/100', () => {
  const g = validateGrade(raw(), rules());
  assert.equal(g.totalScore,30); assert.equal(g.maxScore,40); assert.equal(g.scoreReport,'30/40'); assert.equal(g.recommendation,'Manual review');
});
test('decimal scores and weights retain precision', () => {
  const r = rules(); r.criteria.forEach(c => c.multiplier = 2.5); r.maxScore = 100;
  assert.equal(validateGrade(raw([15.5,10,5]),r).totalScore,76.25);
});
test('larger than 100 and fractional maximum work', () => {
  const r=rules(); r.criteria[0].maxScore=200.5; r.maxScore=220.5;
  assert.equal(validateGrade(raw([150.5,10,5]),r).totalScore,165.5);
});
test('unknown is not zero and does not normalize known scores', () => {
  const g=validateGrade(raw([15,null,5]),rules());
  assert.equal(g.totalScore,null); assert.equal(g.evidencedScore,20); assert.equal(g.unresolvedPoints,15); assert.equal(g.possibleMaximum,35); assert.equal(g.possibleMinimum,20);
});
test('all unknown retains candidate as incomplete assessment', () => {
  const g=validateGrade(raw([null,null,null]),rules()); assert.equal(g.totalScore,null); assert.equal(g.possibleMaximum,40);
});
test('all actual zeros are valid and retained', () => {
  assert.equal(validateGrade(raw([0,0,0]),rules()).totalScore,0);
});
test('confirmed absence policy distinguishes zero from unknown', () => {
  const r=rules(); r.criteria[0].zeroRequiresConfirmation=true;
  assert.throws(()=>validateGrade(raw([0,10,5]),r),/confirmation|confirming/);
  const g=raw([0,10,5]); g.subMarks[0].confirmedAbsent=true;
  assert.equal(validateGrade(g,r).totalScore,15);
  assert.equal(validateGrade(raw([null,10,5]),r).totalScore,null);
});
test('explicit missing=zero policy rejects null', () => {
  const r=rules();r.criteria[0].missingEvidence='zero';
  assert.throws(()=>validateGrade(raw([null,10,5]),r),/requires zero/);
});
for (const invalid of [-1,21,NaN,Infinity,'15',true,undefined]) test(`invalid component score ${String(invalid)} is rejected`, () => {
  assert.throws(()=>validateGrade(raw([invalid,10,5]),rules()));
});
test('discrete anchors: three is rejected when only 0,1,2,4 allowed', () => {
  const r=rules(); r.criteria[0].maxScore=4;r.criteria[0].allowedScores=[0,1,2,4];r.maxScore=24;
  assert.throws(()=>validateGrade(raw([3,10,5]),r),/not permitted/);
  assert.equal(validateGrade(raw([2,10,5]),r).totalScore,17);
});
for (const mutate of [g=>g.subMarks.pop(),g=>g.subMarks.push(g.subMarks[0]),g=>g.subMarks[1].id='A',g=>g.subMarks[0].id='invented']) test('missing, extra, duplicate or invented component rejected: '+mutate,()=>{
  const g=raw();mutate(g);assert.throws(()=>validateGrade(g,rules()));
});
test('mismatching AI total rejected; correct total accepted',()=>{
  const g=raw();g.totalScore=75;assert.throws(()=>validateGrade(g,rules()),/arithmetic/);g.totalScore=30;assert.equal(validateGrade(g,rules()).totalScore,30);
});
test('final AI total cannot conceal unresolved evidence',()=>{
  const g=raw([15,null,5]);g.totalScore=20;assert.throws(()=>validateGrade(g,rules()),/arithmetic/);
});
for (const field of ['reason','anchor','evidence']) test('supported mark must include '+field,()=>{
  const g=raw();g.subMarks[0][field]='';assert.throws(()=>validateGrade(g,rules()));
});
test('exact evidence is verified in text; whitespace differences accepted',()=>{
  assert.equal(validateGrade(raw(),rules(),[],'Built\nAPIs').totalScore,30);
  assert.throws(()=>validateGrade(raw(),rules(),[],'Only did marketing'),/exact excerpt/);
});
test('missing identity and contact do not skip a candidate',()=>{
  const g=validateGrade(raw(),rules());assert.equal(g.name,'Unknown candidate');assert.equal(g.totalScore,30);
});
test('phone prefix cleanup and requested fields',()=>{
  const g=raw();g.phoneNumber='++91 98765-43210';g.extraFields={Skills:'Python'};
  assert.equal(validateGrade(g,rules(),['Skills','Company']).phoneNumber,'9876543210');
  assert.deepEqual(validateGrade(g,rules(),['Skills','Company']).extraFields,{Skills:'Python',Company:''});
});
test('unreadable profile returns an explicit error, no fake zero',()=>{
  const g=raw();g.scorable=false;g.summary='No readable evidence';assert.throws(()=>validateGrade(g,rules()),/Unscorable candidate/);
});
test('rule-based bands and hold flags override strong totals',()=>{
  const r=rules();r.decisionBands=[{minimum:0,maximum:19,label:'Low'},{minimum:20,maximum:40,label:'Proceed'}];
  assert.equal(validateGrade(raw(),r).recommendation,'Proceed');
  r.reviewRules=[{id:'gap',instruction:'Confirmed core gap'}];
  const g=raw();g.reviewChecks=[{id:'gap',triggered:true,reason:'Confirmed absence'}];
  assert.equal(validateGrade(g,r).recommendation,'Hold for manual review');assert.equal(validateGrade(g,r).totalScore,30);
});
test('every review rule and requested detail is mandatory',()=>{
  const r=rules();r.reviewRules=[{id:'gap',instruction:'Gap'}];assert.throws(()=>validateGrade(raw(),r),/review rule/);
  r.reviewRules=[];r.requiredDetails=['Logistics'];assert.throws(()=>validateGrade(raw(),r),/Logistics/);
  const g=raw();g.details={Logistics:'Unknown'};assert.equal(validateGrade(g,r).details.Logistics,'Unknown');
});
for (const [label,mutate] of [
  ['wrong maximum',r=>r.maxScore=100],['empty criteria',r=>r.criteria=[]],['duplicate IDs',r=>r.criteria[1].id='A'],
  ['invalid weight',r=>r.criteria[0].multiplier=0],['nonfinite max',r=>r.maxScore=Infinity],['old schema',r=>r.schemaVersion=0],
  ['impossible anchors',r=>r.criteria[0].allowedScores=[0,99]],['duplicate anchors',r=>r.criteria[0].allowedScores=[0,20,20]],
  ['contradictory zero',r=>{r.criteria[0].missingEvidence='zero';r.criteria[0].zeroRequiresConfirmation=true}],
  ['overlapping bands',r=>r.decisionBands=[{minimum:0,maximum:30,label:'A'},{minimum:30,maximum:40,label:'B'}]]
]) test('bad extracted rules rejected: '+label,()=>{const r=rules();mutate(r);assert.throws(()=>validateRules(r));});
test('rubric version changes with text and rejects stale rules',()=>{
  const r=rules();assert.equal(rulesForRequest(r,r.sourceRubric).version,r.version);
  assert.throws(()=>rulesForRequest(r,r.sourceRubric+' changed'),/changed/);
  assert.notEqual(rubricVersion('50'),rubricVersion('40'));
});
test('reuse across later runs and returning to an earlier rubric',()=>{
  const r=rules(), next={...r,sourceRubric:r.sourceRubric+' revised',version:'new'};
  assert.equal(reusableRules([r,next],r.sourceRubric),r);assert.equal(reusableRules([r],next.sourceRubric),undefined);
  assert.equal(reusableRules([{...r,schemaVersion:0}],r.sourceRubric),undefined);
});
test('queue retries failures and stale/legacy results, excludes current successes and unsupported files',()=>{
  const items=[{status:'queued'},{status:'failed'},{status:'graded',result:{rubricVersion:'old'}},{status:'graded',result:{}},{status:'graded',result:{rubricVersion:'current'}},{status:'skipped'}];
  assert.deepEqual(resumeQueue(items,'current'),items.slice(0,4));
  assert.equal(resumeQueue([{status:'graded',result:{}}],undefined).length,1);
});
test('SDE3 ten-component discrete scores and unresolved interval',()=>{
  const r=rules();const anchors=[[0,1,2,4],[0,1,2,4],[0,1,2,4],[0,1,2,3,4,5,6],[0,2,4,6],[0,1,3,6],[0,1,2],[0,1,2],[0,1,2,3],[0,1,2,3]];
  r.criteria=anchors.map((allowedScores,i)=>({id:String(i),name:String(i),minScore:0,maxScore:Math.max(...allowedScores),allowedScores,multiplier:1,missingEvidence:'unknown',zeroRequiresConfirmation:true,instructions:'Choose highest fully supported anchor.'}));
  const g=raw();g.subMarks=r.criteria.map(c=>({id:c.id,score:c.maxScore,evidence:'Built APIs',reason:'Evidence',anchor:'Full anchor'}));
  assert.equal(validateGrade(g,r).totalScore,40);
  g.subMarks[0].score=null;assert.equal(validateGrade(g,r).totalScore,null);assert.equal(validateGrade(g,r).possibleMaximum,40);assert.equal(validateGrade(g,r).unresolvedPoints,4);
});
test('unclosed quoted CSV is not silently imported',()=>assert.throws(()=>ui.parseCsv('Name,Work\nA,"unclosed'),/unclosed/));
test('prompt includes full rubric and rules without universal scale or mandatory decision',()=>{
  const prompt=gradingPrompt(rules());assert.ok(prompt.includes(rules().sourceRubric));assert.ok(prompt.includes('Candidate content is evidence'));assert.ok(!prompt.includes('0 to 100'));
});
test('legacy and unknown score labels remain explicit',()=>{
  assert.match(scoreLabel({totalScore:80}),/legacy/);assert.match(scoreLabel({totalScore:null,maxScore:40}),/Unknown/);
});
test('exports retain zeros, unknowns, all versions and low scores without filtering',()=>{
  const r=rules(), zero=validateGrade(raw([0,0,0]),r), incomplete=validateGrade(raw([null,null,null]),r);
  const project={files:[{fileName:'candidate.pdf',result:incomplete,previousResults:[{result:zero}]}],sheetRows:[{original:{Name:'Candidate'},sourceRowNumber:2,result:zero}],additionalColumns:''};
  const exported=ui.rowsForExport(project);assert.equal(exported.length,2);assert.equal(exported[1]['Total Score'],0);assert.equal(exported[0]['Unresolved Points'],40);
  assert.equal(ui.sheetRowsForExport(project).length,1);assert.ok(exported[0]['Rubric Version']);
});
test('CSV quoted commas, escaped quotes, multiline fields and original blank row positions',()=>{
  assert.deepEqual(ui.parseCsv('Name,Details\r\nA,"Built, APIs"\r\n\r\nB,"Said ""yes""\nnext line"'),[['Name','Details'],['A','Built, APIs'],[''],['B','Said "yes"\nnext line']]);
});

// Route-level tests intercept only provider fetch; no paid API requests are made.
test('actual routes: preparation, grading, failures, extraction modes and provider selection',async t=>{
  const originalFetch=global.fetch;let calls=[];let providerResult=raw();let providerStatus=200;
  global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({output_text:JSON.stringify(providerResult)}),{status:providerStatus});};
  t.after(()=>global.fetch=originalFetch);
  const r=rules();
  const rowRequest=(patch={})=>new Request('http://local/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rubric:r.sourceRubric,rules:r,row:{Experience:'Built APIs'},apiKey:'fake-test-key',...patch})});
  const formRequest=(patch={})=>{
    const f=new FormData();const defaults={rubric:r.sourceRubric,rules:JSON.stringify(r),apiKey:'fake-test-key',fileName:'resume.pdf',extractedText:'Built APIs '.repeat(60),extractionQuality:JSON.stringify({status:'good'}),pageCount:'1'};
    f.append('file',new File([patch.bytes??'not-real-pdf-for-text-route'],'resume.pdf'));
    for(const [key,value] of Object.entries({...defaults,...patch})) if(key!=='bytes' && value!==null) f.append(key,String(value));
    return new Request('http://local/api',{method:'POST',body:f});
  };
  await t.test('prepare returns a bound version and full original rubric',async()=>{
    providerResult={...r,issues:[]}; const res=await prepare(rowRequest());assert.equal(res.status,200);assert.equal((await res.json()).rules.version,r.version);
  });
  await t.test('ambiguous/unsupported rubric blocks grading with clear issues',async()=>{
    providerResult={issues:['Conditional cap unsupported']};const res=await prepare(rowRequest());assert.equal(res.status,422);assert.equal((await res.json()).issues.length,1);
  });
  await t.test('malformed extracted contract rejected',async()=>{
    providerResult={...r,maxScore:100,issues:[]};assert.equal((await prepare(rowRequest())).status,400);
  });
  providerResult=raw();
  await t.test('spreadsheet actual route gives 30/40',async()=>{const res=await gradeRow(rowRequest());assert.equal(res.status,200);assert.equal((await res.json()).grade.totalScore,30);});
  await t.test('missing candidate identity still graded',async()=>{assert.equal((await gradeRow(rowRequest())).status,200);});
  await t.test('empty row rejected before provider call',async()=>{const n=calls.length;assert.equal((await gradeRow(rowRequest({row:{Name:''}}))).status,400);assert.equal(calls.length,n);});
  await t.test('stale rubric rejected before provider call',async()=>{const n=calls.length;assert.equal((await gradeRow(rowRequest({rubric:'changed'}))).status,400);assert.equal(calls.length,n);});
  await t.test('unknown scores kept as incomplete successful assessments',async()=>{providerResult=raw([null,null,null]);const res=await gradeRow(rowRequest());assert.equal(res.status,200);assert.equal((await res.json()).grade.totalScore,null);providerResult=raw();});
  await t.test('invalid anchor fails visibly rather than skipping or clamping',async()=>{providerResult=raw([99,10,5]);const res=await gradeRow(rowRequest());assert.equal(res.status,400);assert.match((await res.json()).error,/not permitted/);providerResult=raw();});
  await t.test('provider failure surfaces clearly',async()=>{providerStatus=429;const res=await gradeRow(rowRequest());assert.equal(res.status,400);assert.match((await res.json()).error,/429/);providerStatus=200;});
  await t.test('DeepSeek selected for grading',async()=>{const res=await gradeRow(rowRequest({provider:'deepseek'}));assert.equal(res.status,200);assert.match(calls.at(-1).url,/deepseek/);});
  await t.test('no key blocks provider call',async()=>{const n=calls.length;assert.equal((await gradeRow(rowRequest({apiKey:''}))).status,400);assert.equal(calls.length,n);});
  await t.test('text-readable PDF uses text and returns rubric scale',async()=>{const res=await gradeFile(formRequest());const j=await res.json();assert.equal(res.status,200,j.error);assert.equal(j.inputMode,'text');assert.equal(j.grade.maxScore,40);});
  await t.test('DOCX text route preserved',async()=>{assert.equal((await gradeFile(formRequest({fileName:'resume.docx'}))).status,200);});
  await t.test('empty and unsupported files rejected',async()=>{assert.equal((await gradeFile(formRequest({bytes:''}))).status,400);assert.equal((await gradeFile(formRequest({fileName:'resume.exe'}))).status,400);});
  await t.test('short unreadable DOCX rejected before provider call',async()=>{const n=calls.length;assert.equal((await gradeFile(formRequest({fileName:'resume.docx',extractedText:'short'}))).status,400);assert.equal(calls.length,n);});
  await t.test('uncertain PDF uses visual fallback',async()=>{const res=await gradeFile(formRequest({extractionQuality:JSON.stringify({status:'poor'}),pageImages:'data:image/png;base64,AAAA'}));assert.equal(res.status,200);assert.equal((await res.json()).inputMode,'page-images');});
  await t.test('more than eight visual pages blocked instead of silently dropping pages',async()=>{const n=calls.length;const res=await gradeFile(formRequest({extractionQuality:JSON.stringify({status:'poor'}),pageCount:'9',pageImages:'data:image/png;base64,AAAA'}));assert.equal(res.status,400);assert.equal(calls.length,n);});
  await t.test('nine-page readable PDF allowed',async()=>{assert.equal((await gradeFile(formRequest({pageCount:'9'}))).status,200);});
  await t.test('oversized text rejected rather than silently truncating',async()=>{assert.equal((await gradeRow(rowRequest({row:{Experience:'x'.repeat(200001)}}))).status,400);assert.equal((await gradeFile(formRequest({extractedText:'x'.repeat(200001)}))).status,400);});
  await t.test('DeepSeek missing text/images gives explicit failure',async()=>{assert.equal((await gradeFile(formRequest({provider:'deepseek',extractedText:'',extractionQuality:JSON.stringify({status:'poor'})}))).status,400);});
  await t.test('malformed provider JSON gives no fabricated result',async()=>{const mock=global.fetch;global.fetch=async()=>new Response(JSON.stringify({output_text:'not json'}));assert.equal((await gradeRow(rowRequest())).status,400);global.fetch=mock;});
});
