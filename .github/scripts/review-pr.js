require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

const excludedFiles = ['package-lock.json', 'package.json', 'review-pr.js'];
const fileExtensions = ['js', 'ts', 'jsx', 'tsx'];

const owner = process.env.OWNER;
const repo = process.env.REPO;
const prNumber = process.env.PR_NUMBER;

console.log(`Reviewing PR #${prNumber} in ${owner}/${repo}...`);

// Public inference models endpoints
// https://api-inference.huggingface.co/models/google/flan-t5-base
// https://api-inference.huggingface.co/models/facebook/opt-iml-1.3b

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
};

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

async function callHuggingFaceAPI(octokit, pr, file, guidelines, retries = 0) {
  try {
    const { data: fileContent } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: file.filename,
      ref: pr.head.sha
    });

    const fileText = Buffer.from(fileContent.content, 'base64').toString();
    console.log(`Analyzing file: ${file.filename}`);

    const response = await axios.post(
      'https://api-inference.huggingface.co/models/google/flan-t5-base',
      {
        inputs: `
          Review this code and provide specific line-by-line comments:

          ${fileText}

          Guidelines:
          ${guidelines}

          Provide comments in this format:
          Line <number>: <comment>
        `,
        parameters: {
          max_length: 1000,
          temperature: 0.7,
          top_p: 0.95
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    console.log(`✅ Analysis completed for ${file.filename}`);

    const comments = [];
    const reviewText = response.data[0].generated_text;
    const lines = reviewText.split('\n');

    lines.forEach(line => {
      const match = line.match(/Line (\d+): (.+)/);
      if (match) {
        comments.push({
          path: file.filename,
          position: parseInt(match[1], 10),
          body: match[2].trim()
        });
      }
    });

    console.log(`Found ${comments.length} comments for ${file.filename}`);

    return comments;

  } catch (error) {
    if (retries < MAX_RETRIES) {
      console.log(`API call failed, retrying in ${RETRY_DELAY / 1000} seconds... (${retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callHuggingFaceAPI(octokit, pr, file, guidelines, retries + 1);
    }
    console.error(`Error processing file ${file.filename}:`, error.message);
    throw error;
  }
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

      if (excludedFiles.includes(file.filename)) {
        console.log(`File ${file.filename} is excluded from review.`);
        return null;
      }

      const fileExt = file.filename.split('.').pop().toLowerCase();
      if (!fileExtensions.includes(fileExt)) {
        console.log(`File ${file.filename} has unsupported extension: ${fileExt}`);
        return null;
      }

      try {
        const comments = await callHuggingFaceAPI(octokit, pr, file, guidelines);
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
