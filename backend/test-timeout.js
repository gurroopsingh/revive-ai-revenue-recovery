const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
  console.log("Starting test...");
  const genAI = new GoogleGenerativeAI('invalid_key');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  
  let timerHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timerHandle = setTimeout(() => {
      console.log("Timeout fired!");
      const e = new Error('Gemini call timed out after 5s');
      e.name = 'AbortError';
      reject(e);
    }, 5000);
  });

  const generatePromise = model.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
  }).finally(() => {
    console.log("generatePromise settled, clearing timeout");
    clearTimeout(timerHandle);
  });

  try {
    const result = await Promise.race([generatePromise, timeoutPromise]);
    console.log("Result:", result.response.text());
  } catch(e) {
    console.log("Caught:", e.message);
  }
}

test().then(() => console.log("Done")).catch(console.error);
