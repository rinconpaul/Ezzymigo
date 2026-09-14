import fs from 'fs';

const fileContent = fs.readFileSync('server/ai/interpreter.ts', 'utf-8');
const match = fileContent.match(/systemInstruction:\s*`([\s\S]*?)`,/);

if (match) {
  const prompt = match[1];
  console.log('--- PROMPT METRICS BEFORE ---');
  console.log(`Total Characters: ${prompt.length}`);
  console.log(`Total Words: ${prompt.trim().split(/\s+/).length}`);
  console.log(`Approx Tokens (~chars / 4): ${Math.round(prompt.length / 4)}`);
  console.log(`Total Lines: ${prompt.split('\n').length}`);
} else {
  console.error('Could not extract systemInstruction');
}
