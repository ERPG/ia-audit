require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const path = require('path');

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

const excludedFiles = ['package-lock.json', 'package.json', 'review.js'];
const fileExtensions = ['js', 'ts', 'jsx', 'tsx'];

const owner = process.env.OWNER;
const repo = process.env.REPO;
const prNumber = process.env.PR_NUMBER;

console.log(`Reviewing PR #${prNumber} in ${owner}/${repo}...`);

// Public inference models endpoints
// https://api-inference.huggingface.co/models/Salesforce/codegen-350M-multi
// https://api-inference.huggingface.co/models/google/flan-t5-base
// https://api-inference.huggingface.co/models/facebook/opt-iml-1.3b

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDiffPosition(diff, filePath, lineNumber) {
  const fileDiff = diff.split('diff --git').find(d => d.includes(`b/${filePath}`));
  if (!fileDiff) return null;

  const lines = fileDiff.split('\n');
  let position = 0;
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+,\d+ \+(\d+)/);
      if (match) {
        currentLine = parseInt(match[1], 10) - 1;
      }
      position = 1;
      continue;
    }

    if (!line.startsWith('-')) {
      currentLine++;
    }

    if (currentLine === lineNumber) {
      return position;
    }

    position++;
  }
  return null;
};

function getFileDiff(fullDiff, filePath) {
  const parts = fullDiff.split('diff --git');
  const chunk = parts.find(d => d.includes(` b/${filePath}`));
  return chunk ? 'diff --git' + chunk : '';
};

function chunkDiff(diffText, maxLines = 200) {
  const lines = diffText.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return chunks;
};

async function callHuggingFaceAPI(pr, file, guidelines) {
  // Extract this file’s diff and split into manageable hunks
  const fileDiff = getFileDiff(pr.diff, file.filename);
  const hunks = chunkDiff(fileDiff);

  // Helper to review one hunk with retries
  const reviewHunk = async (hunk, attempt = 0) => {
    const prompt = `
    You are an expert reviewer. Here is a chunk of the git diff for ${file.filename}:

    ${hunk}

    Follow these coding guidelines when you review:
    
    ${guidelines}
    
    Please return a JSON array like:
    [
      {"line": 12, "comment": "Missing initial value for useState."},
      …
    ]
          `;
    try {
      const res = await axios.post(
        'https://api-inference.huggingface.co/models/Salesforce/codegen-350M-multi',
        { inputs: prompt, parameters: { max_new_tokens: 512, temperature: 0.2 } },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000
        }
      );
      const text = Array.isArray(res.data)
        ? res.data[0].generated_text
        : res.data.generated_text;
      return JSON.parse(text);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`Hunk review failed, retry ${attempt + 1}/${MAX_RETRIES}…`);
        await sleep(RETRY_DELAY);
        return reviewHunk(hunk, attempt + 1);
      }
      console.error(`❌ Hunk failed after ${MAX_RETRIES} attempts:`, err.message);
      return [];
    }
  };

  console.log(`Analyzing file: ${file.filename}`);

  // Review all hunks in parallel with retry logic
  const flatComments = await hunks.reduce(
    (chain, hunk) =>
      chain.then(async accumulated => {
        const comments = await reviewHunk(hunk);
        await sleep(1000);
        return accumulated.concat(comments);
      }),
    Promise.resolve([])
  );


  // Flatten and map into GH review format
  return flatComments.map(c => ({
    path: file.filename,
    position: c.line,
    body: c.comment
  }));
};

async function reviewPR() {

  const { Octokit } = await import('@octokit/core');
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const guidelines = fs.readFileSync('.github/CODE_STYLE.md', 'utf-8');

  const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: prNumber,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  const diffResponse = await axios.get(pr.diff_url);
  const diffContent = diffResponse.data;
  pr.diff = diffContent;

  console.log('diffContent: ', diffContent);

  const { data: files } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
    owner,
    repo,
    pull_number: prNumber,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  console.log(`--- Reviewing PR #${prNumber} in ${owner}/${repo} ---`);

  const reviewComments = await Promise.all(
    files.map(async (file, index) => {
      console.log(`Processing file #${index + 1}: ${file.filename}`);

      const filename = file.filename;
      const base = path.basename(filename);

      if (excludedFiles.includes(filename) || excludedFiles.includes(base)) {
        console.log(`File ${filename} is excluded from review.`);
        return null;
      }

      const fileExt = file.filename.split('.').pop().toLowerCase();
      if (!fileExtensions.includes(fileExt)) {
        console.log(`File ${file.filename} has unsupported extension: ${fileExt}`);
        return null;
      }

      try {
        const comments = await callHuggingFaceAPI(pr, file, guidelines);
        return comments;
      } catch (error) {
        console.error(`Error processing file ${file.filename}:`, error.message);
        return null;
      }

    })
  );

  const validComments = reviewComments.filter(Boolean).flat();
  console.log('\nReview Summary:');
  console.log(`- Total files processed: ${files.length}`);
  console.log(`- Total comments generated: ${validComments.length}`);
  console.log(`- Comments: ${JSON.stringify(validComments)}`);

  if (validComments.length > 0) {
    try {
      await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: prNumber,
        event: 'REQUEST_CHANGES',
        commit_id: pr.head.sha,
        body: '🤖 Code review completed. Please address the following comments:',
        comments: validComments.map(comment => ({
          path: comment.path,
          position: getDiffPosition(diffContent, comment.path, comment.position),
          body: comment.body
        }))
      });

      console.log('✅ Review comments posted successfully');
    } catch (error) {
      console.error('❌ Failed to post review comments:', error.message);
      throw error;
    }
  } else {
    console.log('ℹ️ No valid comments to post to the PR');
  }

  console.log('Review completed.');
};

(async () => {
  try {
    const response = await reviewPR();
    console.log('reviewPR - Response: ', response);
  } catch (error) {
    console.log('reviewPR - error: ', error);
    console.error(error);
    process.exit(1);
  }
})();
