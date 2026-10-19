// Run against a separate local test server/origin; never opens the user's saved projects.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_TEST_EXECUTABLE ? {executablePath:process.env.CHROME_TEST_EXECUTABLE}: {}) });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let prepared=0, graded=0, delay=0, failNext=false, unknown=false, malformedNext=false, unclearRubric=false;
  const rubric1='Experience maximum 40. Score based on evidence. Missing evidence unknown. Manual review only.';
  const rubric2='Experience maximum 60. Score based on evidence. Missing evidence unknown. Manual review only.';
  const makeRules = rubric => ({schemaVersion:1,sourceRubric:rubric,version:'v1-'+createHash('sha256').update(rubric).digest('hex'),title:'Browser test rubric',maxScore:rubric===rubric2?60:40,criteria:[{id:'A',name:'Experience',minScore:0,maxScore:rubric===rubric2?60:40,allowedScores:null,multiplier:1,missingEvidence:'unknown',zeroRequiresConfirmation:false,instructions:'Use evidence'}],instructions:'Manual review only',decisionBands:[],reviewRules:[],requiredDetails:[]});
  await page.route('**/api/resume-evaluator/prepare-rubric',async route=>{
    prepared++; if(unclearRubric){await route.fulfill({status:422,json:{error:"Rubric needs clarification before scoring.",issues:["Contradictory scoring rules"]}});return;} await route.fulfill({json:{rules:makeRules(route.request().postDataJSON().rubric)}});
  });
  await page.route('**/api/resume-evaluator/grade-row',async route=>{
    graded++;if(malformedNext){malformedNext=false;await route.fulfill({json:{}});return;}const body=route.request().postDataJSON();
    if(delay) await new Promise(r=>setTimeout(r,delay));
    if(failNext){failNext=false;await route.fulfill({status:400,json:{error:'Simulated provider rate limit'}}).catch(()=>{});return;}
    const maxScore=body.rules.maxScore;
    const grade={name:body.row.Name||'Unknown candidate',phoneNumber:'',email:'',linkedInUrl:'',extraFields:{},totalScore:unknown?null:30,maxScore,evidencedScore:unknown?0:30,unresolvedPoints:unknown?maxScore:0,possibleMinimum:unknown?0:30,possibleMaximum:unknown?maxScore:30,rubricVersion:body.rules.version,scoreReport:unknown?`0 evidenced points; ${maxScore} unresolved; possible interval 0–${maxScore}/${maxScore}`:`30/${maxScore}`,recommendation:'Manual review',disposition:'Manual review',scorable:true,subMarks:[{id:'A',section:'Experience',score:unknown?null:30,maxScore,evidence:'Built APIs',anchor:'Supported',reason:'Evidence'}],reviewFlags:[],details:{},remarks:{strengths:[],weaknesses:[],selectedOrRejectedReason:'Manual comparison',missingEvidence:[],risks:[]},summary:'Assessment'};
    await route.fulfill({json:{grade}}).catch(()=>{});
  });
  const log = text=>console.log('PASS '+text);
  const upload = async content=>page.locator('input[type=file]').setInputFiles({name:'candidates.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  const run=async()=>{await page.getByRole('button',{name:/Grade Rows/}).click();await page.getByRole('button',{name:/Grade Rows/}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('textarea.resume-rubric')?.disabled);};
  try {
    await page.goto(process.env.TEST_BASE_URL||'http://localhost:4012/resume-evaluator');
    await page.locator('textarea.resume-rubric').fill(rubric1);
    await page.locator('input[type=password]').fill('fake-test-key');
    await page.getByRole('button',{name:'Excel Sheet',exact:true}).click();
    await upload('Name,Experience\nA,Built APIs\nB,Built APIs\nC,Built APIs\nD,Built APIs\nE,Built APIs');
    await page.getByText('Loaded 5 rows from candidates.csv.',{exact:true}).waitFor();
    await run(); assert.equal(prepared,1);assert.equal(graded,5);
    assert.equal(await page.locator('tbody tr td:nth-child(6)').filter({hasText:'30/40'}).count(),5);
    log('Five candidates graded with one rubric preparation');
    await page.reload();await page.locator('textarea.resume-rubric').waitFor();
    await upload('Name,Experience\nLater,Built APIs');await page.getByText('Loaded 1 rows from candidates.csv.',{exact:true}).waitFor();
    await run();assert.equal(prepared,1);assert.equal(graded,6);log('Saved rules reused after reload and new upload');
    await page.locator('textarea.resume-rubric').fill(rubric2);
    await run();assert.equal(prepared,2);assert.equal(graded,7);
    await page.locator('tbody tr td:nth-child(6)').filter({hasText:'30/60'}).waitFor();
    assert.equal(await page.getByText('Rubric details and history (1)',{exact:true}).count(),1);
    log('Rubric edit re-evaluates stale result and retains old version');
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();
    const download=await downloadPromise;const csv=fs.readFileSync(await download.path(),'utf8');
    assert.ok(csv.includes('30/40')&&csv.includes('30/60')&&csv.includes('Rubric Version'));
    log('CSV exports both versions and low scores without hidden cutoff');
    await page.locator('textarea.resume-rubric').fill(rubric1);await run();assert.equal(prepared,2);log('Returning to an old rubric reuses its saved rules');
    unknown=true;await page.getByRole('button',{name:'Grade',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('textarea.resume-rubric')?.disabled);
    await page.getByText(/0 evidenced points; 40 unresolved/).first().waitFor();log('Unknown evidence remains visible as incomplete, not a zero score');unknown=false;
    malformedNext=true;await page.getByRole('button',{name:'Grade',exact:true}).click();await page.getByText('Invalid or mismatched grading response. Retry this candidate.',{exact:true}).waitFor();log('Malformed success response cannot mark a candidate graded');
    failNext=true;await page.getByRole('button',{name:'Grade',exact:true}).click();await page.getByText('Simulated provider rate limit',{exact:true}).waitFor();
    await run();await page.locator('tbody tr td:nth-child(6)').filter({hasText:'30/40'}).waitFor();log('Failed candidate remains visible and can be retried');
    await upload('Name,Experience\nStopTest,Built APIs');await page.getByText('Loaded 1 rows from candidates.csv.',{exact:true}).waitFor();
    delay=1000;await page.getByRole('button',{name:/Grade Rows/}).click();await page.getByRole('button',{name:'Stop Grading',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('textarea.resume-rubric')?.disabled);delay=0;
    await run();await page.locator('tbody tr td:nth-child(6)').filter({hasText:'30/40'}).waitFor();log('Stopped run leaves candidate retryable');
    await upload('Name,Name\nA,B');await page.getByText(/Duplicate column names would overwrite/).waitFor();
    await page.getByText('StopTest',{exact:true}).waitFor();log('Duplicate headers rejected without destroying previous candidates');
    await upload('Name,Experience\nA,"unclosed');await page.getByText(/unclosed quoted field/).waitFor();log('Malformed CSV rejected visibly');
    await page.getByRole('button',{name:'Resume Files',exact:true}).click();
    const fixtureDir=path.resolve(__dirname,'./fixtures/resumes');
    const fixtureFiles=fs.readdirSync(fixtureDir).filter(name=>/\.(pdf|docx)$/.test(name));
    const uploads=fixtureFiles.map(name=>({name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:fs.readFileSync(path.join(fixtureDir,name))}));
    uploads.push({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('unsupported')},{name:'broken.zip',mimeType:'application/zip',buffer:Buffer.from('not an archive')});
    await page.locator('input[type=file]').setInputFiles(uploads);
    await page.getByText(`Added ${fixtureFiles.length} resumes to the queue.`,{exact:true}).waitFor({timeout:60000});
    assert.equal(await page.locator('tbody tr').count(),fixtureFiles.length+2);
    await page.getByText(/Could not unpack ZIP/).waitFor();
    await page.getByText('Not a PDF, DOC, or DOCX file.',{exact:true}).waitFor();
    const scannedRow=page.locator('tbody tr').filter({hasText:'08_scanned_image_only.pdf'});
    assert.ok((await scannedRow.innerText()).includes('poor'));
    log('All 10 real PDF/DOCX fixtures survive upload; scanned PDF flagged poor; corrupt ZIP and unsupported file visible');
    // Simulate a saved interrupted run and a missing original blob, then reload.
    await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('recruno-resume-evaluator',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects');
      const records=await new Promise(resolve=>{const q=store.getAll();q.onsuccess=()=>resolve(q.result);});
      const project=records.find(p=>p.files.length);project.files[0].status='grading';delete project.files[0].blob;
      store.put(project);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject;});db.close();
    });
    await page.reload();await page.getByText('Previous evaluation was interrupted. Ready to retry.',{exact:true}).waitFor();
    // Stop after the missing-blob row is handled; other file requests are mocked errors.
    await page.route('**/api/resume-evaluator/grade',route=>route.fulfill({status:400,json:{error:'Simulated unreadable candidate; retry after re-upload'}}));
    await page.getByRole('button',{name:/Grade Queue/}).click();
    await page.getByText('Original file data is missing. Re-upload this file.',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('textarea.resume-rubric')?.disabled);
    assert.equal(await page.locator('tbody tr').count(),fixtureFiles.length+2);
    log('Interrupted saved run recovers; missing blobs fail visibly; failed files stay in queue/results');
    unclearRubric=true;await page.locator('textarea.resume-rubric').fill(rubric2+' ambiguous');const before=graded;await page.getByRole('button',{name:/Grade Queue/}).click();await page.getByText(/Contradictory scoring rules/).waitFor();assert.equal(graded,before);assert.equal(await page.locator('tbody tr').count(),fixtureFiles.length+2);log('Ambiguous changed rubric blocks evaluation without losing candidate rows');
    assert.deepEqual(errors,[]);log('No unhandled browser errors');
    console.log('Browser checks completed successfully.');
  } finally {await context.close();await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
