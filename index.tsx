
import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import React, { useState, useMemo, useEffect, useCallback, useReducer, useRef, memo } from 'react';
import ReactDOM from 'react-dom/client';
import { generateFullSchema, generateSchemaMarkup, WpConfig } from './schema-generator';

const AI_MODELS = {
    GEMINI_FLASH: 'gemini-2.5-flash',
    GEMINI_IMAGEN: 'imagen-4.0-generate-001',
    OPENAI_GPT4_TURBO: 'gpt-4o',
    OPENAI_DALLE3: 'dall-e-3',
    ANTHROPIC_OPUS: 'claude-3-opus-20240229',
    ANTHROPIC_HAIKU: 'claude-3-haiku-20240307',
    OPENROUTER_DEFAULT: [
        'google/gemini-2.5-flash',
        'anthropic/claude-3-haiku',
        'microsoft/wizardlm-2-8x22b',
        'openrouter/auto'
    ],
    GROQ_MODELS: [
        'llama3-70b-8192',
        'llama3-8b-8192',
        'mixtral-8x7b-32768',
        'gemma-7b-it',
    ]
};


// ════════════════════════════════════════════════════════════════════════════════
// WORD COUNT ENFORCEMENT (2,500-3,000 WORDS MANDATORY)
// ════════════════════════════════════════════════════════════════════════════════

function enforceWordCount(content, minWords = 2500, maxWords = 3000) {
    const textOnly = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = textOnly.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    console.log(`📊 Word Count: ${wordCount} (target: ${minWords}-${maxWords})`);

    if (wordCount < minWords) {
        throw new ContentTooShortError(`CONTENT TOO SHORT: ${wordCount} words (minimum ${minWords} required)`, content, wordCount);
    }

    if (wordCount > maxWords) {
        console.warn(`⚠️  Content is ${wordCount - maxWords} words over target`);
    }

    return wordCount;
}

function checkHumanWritingScore(content) {
    const aiPhrases = [
        'delve into', 'in today\'s digital landscape', 'revolutionize', 'game-changer',
        'unlock', 'leverage', 'robust', 'seamless', 'cutting-edge', 'elevate', 'empower',
        'it\'s important to note', 'it\'s worth mentioning', 'needless to say',
        'in conclusion', 'to summarize', 'in summary', 'holistic', 'paradigm shift',
        'utilize', 'commence', 'endeavor', 'facilitate', 'implement', 'demonstrate',
        'ascertain', 'procure', 'terminate', 'disseminate', 'expedite',
        'in order to', 'due to the fact that', 'for the purpose of', 'with regard to',
        'in the event that', 'at this point in time', 'for all intents and purposes',
        'furthermore', 'moreover', 'additionally', 'consequently', 'nevertheless',
        'notwithstanding', 'aforementioned', 'heretofore', 'whereby', 'wherein',
        'landscape', 'realm', 'sphere', 'domain', 'ecosystem', 'framework',
        'navigate', 'embark', 'journey', 'transform', 'transition',
        'plethora', 'myriad', 'multitude', 'abundance', 'copious',
        'crucial', 'vital', 'essential', 'imperative', 'paramount',
        'optimize', 'maximize', 'enhance', 'augment', 'amplify',
        'intricate', 'nuanced', 'sophisticated', 'elaborate', 'comprehensive',
        'comprehensive guide', 'ultimate guide', 'complete guide',
        'dive deep', 'take a deep dive', 'let\'s explore', 'let\'s dive in'
    ];

    let aiScore = 0;
    const lowerContent = content.toLowerCase();

    aiPhrases.forEach(phrase => {
        const count = (lowerContent.match(new RegExp(phrase, 'g')) || []).length;
        if (count > 0) {
            aiScore += (count * 10);
            console.warn(`⚠️  AI phrase detected ${count}x: "${phrase}"`);
        }
    });

    const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length > 0) {
        const avgLength = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length;
        if (avgLength > 25) {
            aiScore += 15;
            console.warn(`⚠️  Average sentence too long (${avgLength.toFixed(1)} words)`);
        }
    }

    const humanScore = Math.max(0, 100 - aiScore);
    console.log(`🤖 Human Writing Score: ${humanScore}% (target: 100%)`);

    return humanScore;
}

console.log('✅ Schema handler & word count enforcer loaded');


// ════════════════════════════════════════════════════════════════
// 🎥 YOUTUBE VIDEO DEDUPLICATION - CRITICAL FIX FOR DUPLICATE VIDEOS
// ════════════════════════════════════════════════════════════════

function getUniqueYoutubeVideos(videos, count = 2) {
    if (!videos || videos.length === 0) {
        console.warn('⚠️  No YouTube videos provided');
        return null;
    }

    const uniqueVideos = [];
    const usedVideoIds = new Set();

    for (const video of videos) {
        if (uniqueVideos.length >= count) break;

        const videoId = video.videoId || 
                       video.embedUrl?.match(/embed\/([^?&]+)/)?.[1] ||
                       video.url?.match(/[?&]v=([^&]+)/)?.[1] ||
                       video.url?.match(/youtu\.be\/([^?&]+)/)?.[1];

        if (videoId && !usedVideoIds.has(videoId)) {
            usedVideoIds.add(videoId);
            uniqueVideos.push({
                ...video,
                videoId: videoId,
                embedUrl: `https://www.youtube.com/embed/${videoId}`
            });
            console.log(`✅ Video ${uniqueVideos.length} selected: ${videoId} - "${(video.title || '').substring(0, 50)}..."`);
        } else if (videoId) {
            console.warn(`⚠️  Duplicate video skipped: ${videoId}`);
        }
    }

    if (uniqueVideos.length < 2) {
        console.error(`❌ Only ${uniqueVideos.length} unique video(s) found. Need 2 for quality content.`);
    } else {
        console.log(`✅ Video deduplication complete: ${uniqueVideos.length} unique videos ready`);
    }

    return uniqueVideos.length > 0 ? uniqueVideos : null;
}

console.log('✅ YouTube video deduplication function loaded');



// ==========================================
// CONTENT & SEO REQUIREMENTS
// ==========================================
const TARGET_MIN_WORDS = 2200; // Increased for higher quality
const TARGET_MAX_WORDS = 2800;
const TARGET_MIN_WORDS_PILLAR = 3500; // Increased for depth
const TARGET_MAX_WORDS_PILLAR = 4500;
const YOUTUBE_EMBED_COUNT = 2;
const MIN_INTERNAL_LINKS = 8; // User wants 8-12, this is the floor
const MAX_INTERNAL_LINKS = 15;
const MIN_TABLES = 3;
const FAQ_COUNT = 8;
const KEY_TAKEAWAYS = 8;

// SEO Power Words
const POWER_WORDS = ['Ultimate', 'Complete', 'Essential', 'Proven', 'Secret', 'Powerful', 'Effective', 'Simple', 'Fast', 'Easy', 'Best', 'Top', 'Expert', 'Advanced', 'Master', 'Definitive', 'Comprehensive', 'Strategic', 'Revolutionary', 'Game-Changing'];

// Track videos to prevent duplicates
const usedVideoUrls = new Set();


// --- START: Performance & Caching Enhancements ---

/**
 * A sophisticated caching layer for API responses to reduce redundant calls
 * and improve performance within a session.
 */
class ContentCache {
  private cache = new Map<string, {data: any, timestamp: number}>();
  private TTL = 3600000; // 1 hour
  
  set(key: string, data: any) {
    this.cache.set(key, {data, timestamp: Date.now()});
  }
  
  get(key: string): any | null {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.TTL) {
      console.log(`[Cache] HIT for key: ${key}`);
      return item.data;
    }
    console.log(`[Cache] MISS for key: ${key}`);
    return null;
  }
}
const apiCache = new ContentCache();

// --- END: Performance & Caching Enhancements ---


// --- START: Core Utility Functions ---

// Debounce function to limit how often a function gets called
const debounce = (func: (...args: any[]) => void, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: any[]) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(null, args);
        }, delay);
    };
};


/**
 * A highly resilient function to extract a JSON object from a string.
 * It surgically finds the JSON boundaries by balancing brackets, strips conversational text and markdown,
 * and automatically repairs common syntax errors like trailing commas.
 * @param text The raw string response from the AI, which may contain conversational text.
 * @returns The clean, valid JSON object.
 * @throws {Error} if a valid JSON object cannot be found or parsed.
 */
const extractJson = (text: string): string => {
    if (!text || typeof text !== 'string') {
        throw new Error("Input text is invalid or empty.");
    }
    
    // First, try a simple parse. If it's valid, we're done.
    try {
        JSON.parse(text);
        return text;
    } catch (e: any) { /* Not valid, proceed with cleaning */ }

    // Aggressively clean up common conversational text and markdown fences.
    let cleanedText = text
        .replace(/^```(?:json)?\s*/, '') // Remove opening ```json or ```
        .replace(/\s*```$/, '')           // Remove closing ```
        .trim();

    // Remove any remaining markdown blocks
    cleanedText = cleanedText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // Remove trailing commas before closing brackets  
    cleanedText = cleanedText.replace(/,(\s*[}\]])/g, '$1');

    // Find the first real start of a JSON object or array.
    const firstBracket = cleanedText.indexOf('{');
    const firstSquare = cleanedText.indexOf('[');
    
    if (firstBracket === -1 && firstSquare === -1) {
        console.error(`[extractJson] No JSON start characters ('{' or '[') found after cleanup.`, { originalText: text });
        throw new Error("No JSON object/array found. Ensure your prompt requests JSON output only without markdown.");
    }

    let startIndex = -1;
    if (firstBracket === -1) startIndex = firstSquare;
    else if (firstSquare === -1) startIndex = firstBracket;
    else startIndex = Math.min(firstBracket, firstSquare);

    let potentialJson = cleanedText.substring(startIndex);
    
    // Find the balanced end bracket for the structure.
    const startChar = potentialJson[0];
    const endChar = startChar === '{' ? '}' : ']';
    
    let balance = 1;
    let inString = false;
    let escapeNext = false;
    let endIndex = -1;

    for (let i = 1; i < potentialJson.length; i++) {
        const char = potentialJson[i];
        
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        
        if (char === '"' && !escapeNext) {
            inString = !inString;
        }
        
        if (inString) continue;

        if (char === startChar) balance++;
        else if (char === endChar) balance--;

        if (balance === 0) {
            endIndex = i;
            break;
        }
    }

    let jsonCandidate;
    if (endIndex !== -1) {
        jsonCandidate = potentialJson.substring(0, endIndex + 1);
    } else {
        jsonCandidate = potentialJson;
        if (balance > 0) {
            console.warn(`[extractJson] Could not find a balanced closing bracket (unclosed structures: ${balance}). The response may be truncated. Attempting to auto-close.`);
            jsonCandidate += endChar.repeat(balance);
        } else {
             console.warn("[extractJson] Could not find a balanced closing bracket. The AI response may have been truncated.");
        }
    }

    // Attempt to parse the candidate string.
    try {
        JSON.parse(jsonCandidate);
        return jsonCandidate;
    } catch (e) {
        // If parsing fails, try to repair common issues like trailing commas.
        console.warn("[extractJson] Initial parse failed. Attempting to repair trailing commas.");
        try {
            const repaired = jsonCandidate.replace(/,(?=\s*[}\]])/g, '');
            JSON.parse(repaired);
            return repaired;
        } catch (repairError: any) {
            console.error(`[extractJson] CRITICAL FAILURE: Parsing failed even after repair.`, { 
                errorMessage: repairError.message,
                attemptedToParse: jsonCandidate
            });
            throw new Error(`Unable to parse JSON from AI response after multiple repair attempts.`);
        }
    }
};

/**
 * Strips markdown code fences and conversational text from AI-generated HTML snippets.
 * Ensures that only raw, clean HTML is returned, preventing page distortion.
 * @param rawHtml The raw string response from the AI.
 * @returns A string containing only the HTML content.
 */
const sanitizeHtmlResponse = (rawHtml: string): string => {
    if (!rawHtml || typeof rawHtml !== 'string') {
        return '';
    }
    
    // Remove markdown code fences for html, plain text, etc.
    let cleanedHtml = rawHtml
        .replace(/^```(?:html)?\s*/i, '') // Remove opening ```html or ```
        .replace(/\s*```$/, '')           // Remove closing ```
        .trim();

    // In case the AI adds conversational text like "Here is the HTML for the section:"
    // A simple heuristic is to find the first opening HTML tag and start from there.
    const firstTagIndex = cleanedHtml.indexOf('<');
    if (firstTagIndex > 0) {
        // Check if the text before the tag is just whitespace or contains actual words.
        const pretext = cleanedHtml.substring(0, firstTagIndex).trim();
        if (pretext.length > 0 && pretext.length < 100) { // Avoid stripping large amounts of text by accident
            console.warn(`[Sanitize HTML] Stripping potential boilerplate: "${pretext}"`);
            cleanedHtml = cleanedHtml.substring(firstTagIndex);
        }
    }

    return cleanedHtml;
};

/**
 * Extracts a YouTube video ID from various URL formats.
 * @param url The YouTube URL.
 * @returns The 11-character video ID or null if not found.
 */
const extractYouTubeID = (url: string): string | null => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    if (match && match[2].length === 11) {
        return match[2];
    }
    return null;
};


/**
 * Extracts the final, clean slug from a URL, intelligently removing parent paths and file extensions.
 * This ensures a perfect match with the WordPress database slug.
 * @param urlString The full URL to parse.
 * @returns The extracted slug.
 */
const extractSlugFromUrl = (urlString: string): string => {
    try {
        const url = new URL(urlString);
        let pathname = url.pathname;

        // 1. Remove trailing slash to handle URLs like /my-post/
        if (pathname.endsWith('/') && pathname.length > 1) {
            pathname = pathname.slice(0, -1);
        }

        // 2. Get the last segment after the final '/'
        const lastSegment = pathname.substring(pathname.lastIndexOf('/') + 1);

        // 3. Remove common web file extensions like .html, .php, etc.
        const cleanedSlug = lastSegment.replace(/\.[a-zA-Z0-9]{2,5}$/, '');

        return cleanedSlug;
    } catch (error: any) {
        console.error("Could not parse URL to extract slug:", urlString, error);
        // Fallback for non-URL strings, though unlikely
        return urlString.split('/').pop() || '';
    }
};


/**
 * A more professional and resilient fetch function for AI APIs that includes
 * exponential backoff for retries and intelligently fails fast on non-retriable errors.
 * This is crucial for handling rate limits (429) and transient server issues (5xx)
 * while avoiding wasted time on client-side errors (4xx).
 * @param apiCall A function that returns the promise from the AI SDK call.
 * @param maxRetries The maximum number of times to retry the call.
 * @param initialDelay The baseline delay in milliseconds for the first retry.
 * @returns The result of the successful API call.
 * @throws {Error} if the call fails after all retries or on a non-retriable error.
 */
const callAiWithRetry = async (apiCall: () => Promise<any>, maxRetries = 5, initialDelay = 5000) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await apiCall();
        } catch (error: any) {
            console.error(`AI call failed on attempt ${attempt + 1}. Error:`, error);

            const errorMessage = (error.message || '').toLowerCase();
            // Try to get status from error object, or parse it from the message as a fallback.
            const statusMatch = errorMessage.match(/\[(\d{3})[^\]]*\]/); 
            const statusCode = error.status || (statusMatch ? parseInt(statusMatch[1], 10) : null);

            const isNonRetriableClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
            const isContextLengthError = errorMessage.includes('context length') || errorMessage.includes('token limit');
            const isInvalidApiKeyError = errorMessage.includes('api key not valid');

            if (isNonRetriableClientError || isContextLengthError || isInvalidApiKeyError) {
                 console.error(`Encountered a non-retriable error (Status: ${statusCode}, Message: ${error.message}). Failing immediately.`);
                 throw error; // Fail fast.
            }

            // If it's the last attempt for any retriable error, give up.
            if (attempt === maxRetries - 1) {
                console.error(`AI call failed on final attempt (${maxRetries}).`);
                throw error;
            }
            
            let delay: number;
            // --- Intelligent Rate Limit Handling ---
            if (error.status === 429 || statusCode === 429) {
                // Respect the 'Retry-After' header if the provider sends it. This is the gold standard.
                const retryAfterHeader = error.headers?.['retry-after'] || error.response?.headers?.get('retry-after');
                if (retryAfterHeader) {
                    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(retryAfterSeconds)) {
                        // The value is in seconds.
                        delay = retryAfterSeconds * 1000 + 500; // Add a 500ms buffer.
                        console.log(`Rate limit hit. Provider requested a delay of ${retryAfterSeconds}s. Waiting...`);
                    } else {
                        // The value might be an HTTP-date.
                        const retryDate = new Date(retryAfterHeader);
                        if (!isNaN(retryDate.getTime())) {
                            delay = retryDate.getTime() - new Date().getTime() + 500; // Add buffer.
                             console.log(`Rate limit hit. Provider requested waiting until ${retryDate.toISOString()}. Waiting...`);
                        } else {
                             // Fallback if the date format is unexpected.
                             delay = initialDelay * Math.pow(2, attempt) + (Math.random() * 1000);
                             console.log(`Rate limit hit. Could not parse 'Retry-After' header ('${retryAfterHeader}'). Using exponential backoff.`);
                        }
                    }
                } else {
                    // If no 'Retry-After' header, use our more patient exponential backoff.
                    delay = initialDelay * Math.pow(2, attempt) + (Math.random() * 1000);
                    console.log(`Rate limit hit. No 'Retry-After' header found. Using exponential backoff.`);
                }
            } else {
                 // --- Standard Exponential Backoff for Server-Side Errors (5xx) ---
                 const backoff = Math.pow(2, attempt);
                 const jitter = Math.random() * 1000;
                 delay = initialDelay * backoff + jitter;
            }

            console.log(`Retrying in ${Math.round(delay)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error("AI call failed after all retries.");
};

/**
 * Fetches a URL by first attempting a direct connection, then falling back to a
 * series of public CORS proxies. This strategy makes the sitemap crawling feature
 * significantly more resilient to CORS issues and unreliable proxies.
 * @param url The target URL to fetch.
 * @param options The options for the fetch call (method, headers, body).
 * @param onProgress An optional callback to report real-time progress to the UI.
 * @returns The successful Response object.
 * @throws {Error} if the direct connection and all proxies fail.
 */
const fetchWithProxies = async (
    url: string, 
    options: RequestInit = {}, 
    onProgress?: (message: string) => void
): Promise<Response> => {
    let lastError: Error | null = null;
    const REQUEST_TIMEOUT = 20000; // 20 seconds

    const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    // --- Attempt a direct fetch first ---
    try {
        onProgress?.("Attempting direct fetch (no proxy)...");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        const directResponse = await fetch(url, {
            ...options,
            headers: {
                ...browserHeaders,
                ...(options.headers || {}),
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (directResponse.ok) {
            onProgress?.("Successfully fetched directly!");
            return directResponse;
        }
    } catch (error: any) {
        if (error.name !== 'AbortError') {
            onProgress?.("Direct fetch failed (likely CORS). Trying proxies...");
        }
        lastError = error;
    }

    const encodedUrl = encodeURIComponent(url);
    // An expanded and more reliable list of public CORS proxies.
    const proxies = [
        `https://corsproxy.io/?${url}`,
        `https://api.allorigins.win/raw?url=${encodedUrl}`,
        `https://thingproxy.freeboard.io/fetch/${url}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`,
        `https://cors-proxy.fringe.zone/${url}`,
    ];

    for (let i = 0; i < proxies.length; i++) {
        const proxyUrl = proxies[i];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const shortProxyUrl = new URL(proxyUrl).hostname;
            onProgress?.(`Attempting fetch via proxy #${i + 1}: ${shortProxyUrl}`);
            
            const response = await fetch(proxyUrl, {
                ...options,
                 headers: {
                    ...browserHeaders,
                    ...(options.headers || {}),
                },
                signal: controller.signal,
            });

            if (response.ok) {
                onProgress?.(`Success via proxy: ${shortProxyUrl}`);
                return response; // Success!
            }
            const responseText = await response.text().catch(() => `(could not read response body)`);
            lastError = new Error(`Proxy request failed with status ${response.status} for ${shortProxyUrl}. Response: ${responseText.substring(0, 100)}`);
        } catch (error: any) {
            if (error.name === 'AbortError') {
                const shortProxyUrl = new URL(proxyUrl).hostname;
                console.error(`Fetch via proxy #${i + 1} (${shortProxyUrl}) timed out.`);
                lastError = new Error(`Request timed out for proxy: ${shortProxyUrl}`);
            } else {
                console.error(`Fetch via proxy #${i + 1} failed:`, error);
                lastError = error as Error;
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // If we're here, all proxies failed.
    const baseErrorMessage = "We couldn't access your sitemap, even after trying multiple methods. This usually happens for one of two reasons:\n\n" +
        "1. **Security blockage:** Your website's security (like Cloudflare or a server firewall) is blocking our crawler. This is common for protected sites.\n" +
        "2. **Sitemap is private/incorrect:** The sitemap URL isn't publicly accessible or contains an error.\n\n" +
        "**What to try next:**\n" +
        "- Double-check that the sitemap URL is correct and opens in an incognito browser window.\n" +
        "- If you use a service like Cloudflare, check its security logs to see if requests from our proxies are being blocked.\n";
    
    throw new Error(lastError ? `${baseErrorMessage}\nLast Error: ${lastError.message}` : baseErrorMessage);
};


/**
 * Smartly fetches a WordPress API endpoint. If the request is authenticated, it forces a direct
 * connection, as proxies will strip authentication headers. Unauthenticated requests will use
 * the original proxy fallback logic.
 * @param targetUrl The full URL to the WordPress API endpoint.
 * @param options The options for the fetch call (method, headers, body).
 * @returns The successful Response object.
 * @throws {Error} if the connection fails.
 */
const fetchWordPressWithRetry = async (targetUrl: string, options: RequestInit): Promise<Response> => {
    const REQUEST_TIMEOUT = 30000; // 30 seconds for potentially large uploads
    const hasAuthHeader = options.headers && (options.headers as Headers).has('Authorization');

    // If the request has an Authorization header, it MUST be a direct request.
    // Proxies will strip authentication headers and cause a guaranteed failure.
    if (hasAuthHeader) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            const directResponse = await fetch(targetUrl, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return directResponse; // Return the response directly, regardless of status, to be handled by the caller.
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error("WordPress API request timed out.");
            }
            // A TypeError is the classic sign of a CORS error on a failed fetch.
            // This will be caught and diagnosed by the calling function (e.g., verifyWpConnection)
            throw error;
        }
    }

    // --- Fallback to original proxy logic for NON-AUTHENTICATED requests ---
    let lastError: Error | null = null;
    
    // 1. Attempt Direct Connection
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        const directResponse = await fetch(targetUrl, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (directResponse.ok || (directResponse.status >= 400 && directResponse.status < 500)) {
            return directResponse;
        }
        lastError = new Error(`Direct connection failed with status ${directResponse.status}`);
    } catch (error: any) {
        if (error.name !== 'AbortError') {
            console.warn("Direct WP API call failed (likely CORS or network issue). Trying proxies.", error.name);
        }
        lastError = error;
    }
    
    // 2. Attempt with Proxies if Direct Fails
    const encodedUrl = encodeURIComponent(targetUrl);
    const proxies = [
        `https://corsproxy.io/?${encodedUrl}`,
        `https://api.allorigins.win/raw?url=${encodedUrl}`,
    ];

    for (const proxyUrl of proxies) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const shortProxyUrl = new URL(proxyUrl).hostname;
            console.log(`Attempting WP API call via proxy: ${shortProxyUrl}`);
            const response = await fetch(proxyUrl, { ...options, signal: controller.signal });
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                console.log(`Successfully fetched via proxy: ${shortProxyUrl}`);
                return response;
            }
            const responseText = await response.text().catch(() => '(could not read response body)');
            lastError = new Error(`Proxy request failed with status ${response.status} for ${shortProxyUrl}. Response: ${responseText.substring(0, 100)}`);
        } catch (error: any) {
             if (error.name === 'AbortError') {
                const shortProxyUrl = new URL(proxyUrl).hostname;
                console.error(`Fetch via proxy ${shortProxyUrl} timed out.`);
                lastError = new Error(`Request timed out for proxy: ${shortProxyUrl}`);
            } else {
                lastError = error;
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw lastError || new Error("All attempts to connect to the WordPress API failed.");
};


/**
 * Processes an array of items concurrently using async workers, with a cancellable mechanism.
 * @param items The array of items to process.
 * @param processor An async function that processes a single item.
 * @param concurrency The number of parallel workers.
 * @param onProgress An optional callback to track progress.
 * @param shouldStop An optional function that returns true to stop processing.
 */
async function processConcurrently<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    concurrency = 5,
    onProgress?: (completed: number, total: number) => void,
    shouldStop?: () => boolean
): Promise<void> {
    const queue = [...items];
    let completed = 0;
    const total = items.length;

    const run = async () => {
        while (queue.length > 0) {
            if (shouldStop?.()) {
                // Emptying the queue is a robust way to signal all workers to stop
                // after they finish their current task.
                queue.length = 0;
                break;
            }
            const item = queue.shift();
            if (item) {
                await processor(item);
                completed++;
                onProgress?.(completed, total);
            }
        }
    };

    const workers = Array(concurrency).fill(null).map(run);
    await Promise.all(workers);
};

/**
 * Validates and repairs internal link placeholders from AI content. If an AI invents a slug,
 * this "Smart Link Forger" finds the best matching real page based on anchor text and repairs the link.
 * @param content The HTML content string with AI-generated placeholders.
 * @param availablePages An array of page objects from the sitemap, each with 'id', 'title', and 'slug'.
 * @returns The HTML content with invalid link placeholders repaired or removed.
 */
const validateAndRepairInternalLinks = (content: string, availablePages: any[]): string => {
    if (!content || !availablePages || availablePages.length === 0) {
        return content;
    }

    const pagesBySlug = new Map(availablePages.map(p => [p.slug, p]));
    const placeholderRegex = /\[INTERNAL_LINK\s+slug="([^"]+)"\s+text="([^"]+)"\]/g;

    return content.replace(placeholderRegex, (match, slug, text) => {
        // If the slug is valid and exists, we're good.
        if (pagesBySlug.has(slug)) {
            return match; // Return the original placeholder unchanged.
        }

        // --- Slug is INVALID. AI invented it. Time to repair. ---
        console.warn(`[Link Repair] AI invented slug "${slug}". Attempting to repair based on anchor text: "${text}".`);

        const anchorTextLower = text.toLowerCase();
        const anchorWords = anchorTextLower.split(/\s+/).filter(w => w.length > 2); // Meaningful words
        const anchorWordSet = new Set(anchorWords);
        let bestMatch: any = null;
        let highestScore = -1;

        for (const page of availablePages) {
            if (!page.slug || !page.title) continue;

            let currentScore = 0;
            const titleLower = page.title.toLowerCase();

            // Scoring Algorithm
            // 1. Exact title match (very high confidence)
            if (titleLower === anchorTextLower) {
                currentScore += 100;
            }
            
            // 2. Partial inclusion (high confidence)
            // - Anchor text is fully inside the title (e.g., anchor "SEO tips" in title "Advanced SEO Tips for 2025")
            if (titleLower.includes(anchorTextLower)) {
                currentScore += 60;
            }
            // - Title is fully inside the anchor text (rarer, but possible)
            if (anchorTextLower.includes(titleLower)) {
                currentScore += 50;
            }

            // 3. Keyword Overlap Score (the core of the enhancement)
            const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
            if (titleWords.length === 0) continue; // Avoid division by zero
            
            const titleWordSet = new Set(titleWords);
            const intersection = new Set([...anchorWordSet].filter(word => titleWordSet.has(word)));
            
            if (intersection.size > 0) {
                // Calculate a relevance score based on how many words match
                const anchorMatchPercentage = (intersection.size / anchorWordSet.size) * 100;
                const titleMatchPercentage = (intersection.size / titleWordSet.size) * 100;
                // Average the two percentages. This rewards matches that are significant to both the anchor and the title.
                const overlapScore = (anchorMatchPercentage + titleMatchPercentage) / 2;
                currentScore += overlapScore;
            }

            if (currentScore > highestScore) {
                highestScore = currentScore;
                bestMatch = page;
            }
        }
        
        // Use a threshold to avoid bad matches
        if (bestMatch && highestScore > 50) {
            console.log(`[Link Repair] Found best match: "${bestMatch.slug}" with a score of ${highestScore.toFixed(2)}. Forging corrected link.`);
            const sanitizedText = text.replace(/"/g, '&quot;');
            return `[INTERNAL_LINK slug="${bestMatch.slug}" text="${sanitizedText}"]`;
        } else {
            console.warn(`[Link Repair] Could not find any suitable match for slug "${slug}" (best score: ${highestScore.toFixed(2)}). Removing link, keeping text.`);
            return text; // Fallback: If no good match, just return the anchor text.
        }
    });
};

/**
 * The "Link Quota Guardian": Programmatically ensures the final content meets a minimum internal link count.
 * If the AI-generated content is deficient, this function finds relevant keywords in the text and injects
 * new, 100% correct internal link placeholders.
 * @param content The HTML content, post-repair.
 * @param availablePages The sitemap page data.
 * @param primaryKeyword The primary keyword of the article being generated.
 * @param minLinks The minimum number of internal links required.
 * @returns The HTML content with the link quota enforced.
 */
const enforceInternalLinkQuota = (content: string, availablePages: any[], primaryKeyword: string, minLinks: number): string => {
    if (!availablePages || availablePages.length === 0) return content;

    const placeholderRegex = /\[INTERNAL_LINK\s+slug="[^"]+"\s+text="[^"]+"\]/g;
    const existingLinks = [...content.matchAll(placeholderRegex)];
    const linkedSlugs = new Set(existingLinks.map(match => match[1]));

    let deficit = minLinks - existingLinks.length;
    if (deficit <= 0) {
        return content; // Quota already met.
    }

    console.log(`[Link Guardian] Link deficit detected. Need to add ${deficit} more links.`);

    let newContent = content;

    // 1. Create a pool of high-quality candidate pages that are not already linked.
    const candidatePages = availablePages
        .filter(p => p.slug && p.title && !linkedSlugs.has(p.slug) && p.title.split(' ').length > 2) // Filter out pages with very short/generic titles
        .map(page => {
            const title = page.title;
            // Create a prioritized list of search terms from the page title.
            const searchTerms = [
                title, // 1. Full title (highest priority)
                // 2. Sub-phrases (e.g., from "The Ultimate Guide to SEO" -> "Ultimate Guide to SEO", "Guide to SEO")
                ...title.split(' ').length > 4 ? [title.split(' ').slice(0, -1).join(' ')] : [], // all but last word
                ...title.split(' ').length > 3 ? [title.split(' ').slice(1).join(' ')] : [],    // all but first word
            ]
            .filter((v, i, a) => a.indexOf(v) === i && v.length > 10) // Keep unique terms of reasonable length
            .sort((a, b) => b.length - a.length); // Sort by length, longest first

            return { ...page, searchTerms };
        })
        .filter(p => p.searchTerms.length > 0);

    // This tracks which pages we've successfully added a link for in this run to avoid duplicate links.
    const newlyLinkedSlugs = new Set<string>();

    for (const page of candidatePages) {
        if (deficit <= 0) break;
        if (newlyLinkedSlugs.has(page.slug)) continue;

        let linkPlaced = false;
        for (const term of page.searchTerms) {
            if (linkPlaced) break;

            // This advanced regex finds the search term as plain text, avoiding matches inside existing HTML tags or attributes.
            // It looks for the term preceded by a tag closing `>` or whitespace, and followed by punctuation, whitespace, or a tag opening `<`.
            const searchRegex = new RegExp(`(?<=[>\\s\n\t(])(${escapeRegExp(term)})(?=[<\\s\n\t.,!?)])`, 'gi');
            
            let firstMatchReplaced = false;
            const tempContent = newContent.replace(searchRegex, (match) => {
                // Only replace the very first valid occurrence we find for this page.
                if (firstMatchReplaced) {
                    return match; 
                }
                
                const newPlaceholder = `[INTERNAL_LINK slug="${page.slug}" text="${match}"]`;
                console.log(`[Link Guardian] Injecting link for "${page.slug}" using anchor: "${match}"`);
                
                firstMatchReplaced = true;
                linkPlaced = true;
                return newPlaceholder;
            });
            
            if (linkPlaced) {
                newContent = tempContent;
                newlyLinkedSlugs.add(page.slug);
                deficit--;
            }
        }
    }
    
    if (deficit > 0) {
        console.warn(`[Link Guardian] Could not meet the full link quota. ${deficit} links still missing.`);
    }

    return newContent;
};


/**
 * Processes custom internal link placeholders in generated content and replaces them
 * with valid, full URL links based on a list of available pages.
 * @param content The HTML content string containing placeholders.
 * @param availablePages An array of page objects, each with 'id' (full URL) and 'slug'.
 * @returns The HTML content with placeholders replaced by valid <a> tags.
 */
const processInternalLinks = (content: string, availablePages: any[]): string => {
    if (!content || !availablePages || availablePages.length === 0) {
        return content;
    }

    // Create a map for efficient slug-to-page lookups.
    const pagesBySlug = new Map(availablePages.filter(p => p.slug).map(p => [p.slug, p]));

    // Regex to find placeholders like [INTERNAL_LINK slug="some-slug" text="some anchor text"]
    const placeholderRegex = /\[INTERNAL_LINK\s+slug="([^"]+)"\s+text="([^"]+)"\]/g;

    return content.replace(placeholderRegex, (match, slug, text) => {
        const page = pagesBySlug.get(slug);
        if (page && page.id) {
            // Found a valid page, create the link with the full URL.
            console.log(`[Link Processor] Found match for slug "${slug}". Replacing with link to ${page.id}`);
            
            // Add UTM parameters for analytics tracking
            const url = new URL(page.id);
            url.searchParams.set('utm_source', 'wp-content-optimizer');
            url.searchParams.set('utm_medium', 'internal-link');
            url.searchParams.set('utm_campaign', 'content-hub-automation');
            const finalUrl = url.toString();

            // Escape quotes in text just in case AI includes them
            const sanitizedText = text.replace(/"/g, '&quot;');
            return `<a href="${finalUrl}">${sanitizedText}</a>`;
        } else {
            // This should rarely happen now with the new validation/repair/enforcement steps.
            console.warn(`[Link Processor] Could not find a matching page for slug "${slug}". This is unexpected. Replacing with plain text.`);
            return text; // Fallback: just return the anchor text.
        }
    });
};

/**
 * A crucial final-pass sanitizer that finds and removes any malformed or broken
 * internal link placeholders that the AI may have hallucinated.
 * @param content The HTML content string.
 * @returns Clean HTML with broken placeholders removed.
 */
const sanitizeBrokenPlaceholders = (content: string): string => {
    const placeholderRegex = /\[INTERNAL_LINK[^\]]*\]/g;
    return content.replace(placeholderRegex, (match) => {
        const slugMatch = match.match(/slug="([^"]+)"/);
        const textMatch = match.match(/text="([^"]+)"/);

        // A placeholder is valid only if it has a non-empty slug AND non-empty text attribute.
        if (slugMatch && slugMatch[1] && textMatch && textMatch[1]) {
            return match; // It's valid, leave it.
        }

        // Otherwise, it's broken.
        console.warn(`[Sanitizer] Found and removed broken internal link placeholder: ${match}`);
        // Return just the anchor text if it exists, otherwise an empty string to remove the tag entirely.
        return (textMatch && textMatch[1]) ? textMatch[1] : '';
    });
};

/**
 * Generates a high-credibility E-E-A-T author box.
 * @param siteInfo The site's author information for the byline.
 * @param primaryKeyword The primary keyword to generate context-aware credentials.
 * @returns An HTML string for the E-E-A-T box.
 */
const generateEeatBoxHtml = (siteInfo: SiteInfo, primaryKeyword: string): string => {
    // Simple logic to generate somewhat relevant credentials
    let authorCreds = "Content Strategist & Industry Analyst";
    let factCheckerCreds = "Lead Editor & Researcher";
    const lowerKeyword = primaryKeyword.toLowerCase();

    if (lowerKeyword.includes('legal') || lowerKeyword.includes('compliance')) {
        authorCreds = "Legal Tech Analyst";
        factCheckerCreds = "Corporate Attorney, J.D.";
    } else if (lowerKeyword.includes('finance') || lowerKeyword.includes('investing')) {
        authorCreds = "Certified Financial Planner (CFP®)";
        factCheckerCreds = "Chartered Financial Analyst (CFA)";
    } else if (lowerKeyword.includes('health') || lowerKeyword.includes('medical')) {
        authorCreds = "Medical Writer & Health Educator";
        factCheckerCreds = "Board-Certified Physician, M.D.";
    } else if (lowerKeyword.includes('marketing') || lowerKeyword.includes('seo')) {
        authorCreds = "Certified Digital Marketing Consultant";
        factCheckerCreds = "Data Scientist, Marketing Analytics";
    }

    const authorName = siteInfo.authorName || 'Alexios Papaioannou';
    const factCheckerName = "Dr. Emily Carter"; // Fictional expert

    const today = new Date();
    const formattedDate = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    return `
    <div class="eeat-author-box">
      <div class="eeat-row">
        <div class="eeat-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div class="eeat-text"><strong>Written by:</strong> <a href="${siteInfo.authorUrl || '#'}" target="_blank" rel="author">${authorName}</a>, <em>${authorCreds}</em></div>
      </div>
      <div class="eeat-row">
        <div class="eeat-icon" aria-hidden="true">
           <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
        </div>
        <div class="eeat-text"><strong>Published:</strong> ${formattedDate} | <strong>Updated:</strong> ${formattedDate}</div>
      </div>
      <div class="eeat-row">
        <div class="eeat-icon" aria-hidden="true">
           <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        </div>
        <div class="eeat-text"><strong>Fact-checked by:</strong> ${factCheckerName}, <em>${factCheckerCreds}</em></div>
      </div>
       <div class="eeat-row eeat-research-note">
        <div class="eeat-icon" aria-hidden="true">
           <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        </div>
        <div class="eeat-text">This article is the result of extensive research, incorporating insights from peer-reviewed studies and leading industry experts to provide the most accurate and comprehensive information available.</div>
      </div>
    </div>
    `;
};


// --- END: Core Utility Functions ---


// --- TYPE DEFINITIONS ---
type SitemapPage = {
    id: string;
    title: string;
    slug: string;
    lastMod: string | null;
    wordCount: number | null;
    crawledContent: string | null;
    healthScore: number | null;
    updatePriority: string | null;
    justification: string | null;
    daysOld: number | null;
    isStale: boolean;
    publishedState: string;
    status: 'idle' | 'analyzing' | 'analyzed' | 'error';
    analysis?: {
        critique: string;
        suggestions: {
            title: string;
            contentGaps: string[];
            freshness: string;
            eeat: string;
        };
    } | null;
};

export type GeneratedContent = {
    title: string;
    slug: string;
    metaDescription: string;
    primaryKeyword: string;
    semanticKeywords: string[];
    content: string;
    imageDetails: {
        prompt: string;
        altText: string;
        title: string;
        placeholder: string;
        generatedImageSrc?: string;
    }[];
    strategy: {
        targetAudience: string;
        searchIntent: string;
        competitorAnalysis: string;
        contentAngle: string;
    };
    jsonLdSchema: object;
    socialMediaCopy: {
        twitter: string;
        linkedIn: string;
    };
    serpData?: any[] | null;
};

export interface SiteInfo {
    orgName: string;
    orgUrl: string;
    logoUrl: string;
    orgSameAs: string[];
    authorName: string;
    authorUrl: string;
    authorSameAs: string[];
}

export interface ExpandedGeoTargeting {
    enabled: boolean;
    location: string;
    region: string;
    country: string;
    postalCode: string;
}

/**
 * Custom error for when generated content fails a quality gate,
 * but we still want to preserve the content for manual review.
 */
class ContentTooShortError extends Error {
  public content: string;
  public wordCount: number;

  constructor(message: string, content: string, wordCount: number) {
    super(message);
    this.name = 'ContentTooShortError';
    this.content = content;
    this.wordCount = wordCount;
  }
}

/**
 * "Zero-Tolerance Video Guardian": Scans generated content for duplicate YouTube embeds
 * and programmatically replaces the second instance with the correct, unique video.
 * This provides a crucial fallback for when the AI fails to follow instructions.
 * @param content The HTML content string with potential duplicate video iframes.
 * @param youtubeVideos The array of unique video objects that *should* have been used.
 * @returns The HTML content with duplicate videos corrected.
 */
const enforceUniqueVideoEmbeds = (content: string, youtubeVideos: any[]): string => {
    if (!youtubeVideos || youtubeVideos.length < 2) {
        return content; // Not enough videos to have a duplicate issue.
    }

    const iframeRegex = /<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/([^"?&]+)[^>]*><\/iframe>/g;
    const matches = [...content.matchAll(iframeRegex)];
    
    if (matches.length < 2) {
        return content; // Not enough embeds to have duplicates.
    }

    const videoIdsInContent = matches.map(m => m[1]);
    const firstVideoId = videoIdsInContent[0];
    const isDuplicate = videoIdsInContent.every(id => id === firstVideoId);


    if (isDuplicate) {
        const duplicateId = videoIdsInContent[0];
        console.warn(`[Video Guardian] Duplicate video ID "${duplicateId}" detected. Attempting to replace second instance.`);

        const secondVideo = youtubeVideos[1];
        if (secondVideo && secondVideo.videoId && secondVideo.videoId !== duplicateId) {
            const secondMatch = matches[1]; // The second iframe tag found
            // Find the start index of the second match to ensure we don't replace the first one
            const secondMatchIndex = content.indexOf(secondMatch[0], secondMatch.index as number);

            if (secondMatchIndex !== -1) {
                // Construct the replacement iframe tag by replacing just the ID
                const correctedIframe = secondMatch[0].replace(duplicateId, secondVideo.videoId);
                content = content.substring(0, secondMatchIndex) + correctedIframe + content.substring(secondMatchIndex + secondMatch[0].length);
                console.log(`[Video Guardian] Successfully replaced second duplicate with unique video: "${secondVideo.videoId}".`);
            }
        }
    }
    return content;
};


/**
 * Validates and normalizes the JSON object returned by the AI to ensure it
 * has all the required fields, preventing crashes from schema deviations.
 * @param parsedJson The raw parsed JSON from the AI.
 * @param itemTitle The original title of the content item, used for fallbacks.
 * @returns A new object with all required fields guaranteed to exist.
 */
const normalizeGeneratedContent = (parsedJson: any, itemTitle: string): GeneratedContent => {
    const normalized = { ...parsedJson };

    // --- Critical Fields ---
    if (!normalized.title) normalized.title = itemTitle;
    if (!normalized.slug) normalized.slug = itemTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
    if (!normalized.content) {
        console.warn(`[Normalization] 'content' field was missing for "${itemTitle}". Defaulting to empty string.`);
        normalized.content = '';
    }

    // --- Image Details: The main source of errors ---
    if (!normalized.imageDetails || !Array.isArray(normalized.imageDetails) || normalized.imageDetails.length === 0) {
        console.warn(`[Normalization] 'imageDetails' was missing or invalid for "${itemTitle}". Generating default image prompts.`);
        const slugBase = normalized.slug || itemTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
        normalized.imageDetails = [
            {
                prompt: `A high-quality, photorealistic image representing the concept of: "${normalized.title}". Cinematic, professional blog post header image, 16:9 aspect ratio.`,
                altText: `A conceptual image for "${normalized.title}"`,
                title: `${slugBase}-feature-image`,
                placeholder: '[IMAGE_1_PLACEHOLDER]'
            },
            {
                prompt: `An infographic or diagram illustrating a key point from the article: "${normalized.title}". Clean, modern design with clear labels. 16:9 aspect ratio.`,
                altText: `Infographic explaining a key concept from "${normalized.title}"`,
                title: `${slugBase}-infographic`,
                placeholder: '[IMAGE_2_PLACEHOLDER]'
            }
        ];
        
        // Ensure placeholders are injected if missing from content
        if (normalized.content && !normalized.content.includes('[IMAGE_1_PLACEHOLDER]')) {
            const paragraphs = normalized.content.split('</p>');
            if (paragraphs.length > 2) {
                paragraphs.splice(2, 0, '<p>[IMAGE_1_PLACEHOLDER]</p>');
                normalized.content = paragraphs.join('</p>');
            } else {
                normalized.content += '<p>[IMAGE_1_PLACEHOLDER]</p>';
            }
        }
        if (normalized.content && !normalized.content.includes('[IMAGE_2_PLACEHOLDER]')) {
            const paragraphs = normalized.content.split('</p>');
            if (paragraphs.length > 5) {
                paragraphs.splice(5, 0, '<p>[IMAGE_2_PLACEHOLDER]</p>');
                 normalized.content = paragraphs.join('</p>');
            } else {
                 normalized.content += '<p>[IMAGE_2_PLACEHOLDER]</p>';
            }
        }
    }

    // --- Other required fields for UI stability ---
    if (!normalized.metaDescription) normalized.metaDescription = `Read this comprehensive guide on ${normalized.title}.`;
    if (!normalized.primaryKeyword) normalized.primaryKeyword = itemTitle;
    if (!normalized.semanticKeywords || !Array.isArray(normalized.semanticKeywords)) normalized.semanticKeywords = [];
    if (!normalized.strategy) normalized.strategy = { targetAudience: '', searchIntent: '', competitorAnalysis: '', contentAngle: '' };
    if (!normalized.jsonLdSchema) normalized.jsonLdSchema = {};
    if (!normalized.socialMediaCopy) normalized.socialMediaCopy = { twitter: '', linkedIn: '' };

    return normalized as GeneratedContent;
};

const PROMPT_TEMPLATES = {
    cluster_planner: {
        systemInstruction: `You are a master SEO strategist specializing in building topical authority through pillar-and-cluster content models. Your task is to analyze a user's broad topic and generate a complete, SEO-optimized content plan that addresses user intent at every stage.

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object. Do not include any text before or after the JSON.
2.  **FRESHNESS & ACCURACY:** All titles must reflect current trends and be forward-looking (e.g., use '2025' where appropriate).
3.  **Pillar Content:** The 'pillarTitle' must be a broad, comprehensive title for a definitive guide. It must be engaging, keyword-rich, and promise immense value to the reader. Think "The Ultimate Guide to..." or "Everything You Need to Know About...".
4.  **Cluster Content:** The 'clusterTitles' must be an array of 5 to 7 unique strings. Each title should be a compelling question or a long-tail keyword phrase that a real person would search for. These should be distinct sub-topics that logically support and link back to the main pillar page.
    - Good Example: "How Much Does Professional Landscaping Cost in 2025?"
    - Bad Example: "Landscaping Costs"
5.  **Keyword Focus:** All titles must be optimized for search engines without sounding robotic.
{{GEO_TARGET_INSTRUCTIONS}}
6.  **JSON Structure:** The JSON object must conform to this exact structure:
    {
      "pillarTitle": "A comprehensive, SEO-optimized title for the main pillar article.",
      "clusterTitles": [
        "A specific, long-tail keyword-focused title for the first cluster article.",
        "A specific, long-tail keyword-focused title for the second cluster article.",
        "..."
      ]
    }

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object, starting with { and ending with }. Do not add any introductory text, closing remarks, or markdown code fences. Your output will be parsed directly by a machine.`,
        userPrompt: (topic: string) => `Generate a pillar-and-cluster content plan for the topic: "${topic}".`
    },
    content_meta_and_outline: {
        systemInstruction: `You are an ELITE content strategist and SEO expert, specializing in creating content that ranks for featured snippets and voice search. Your task is to generate ALL metadata and a comprehensive structural plan for a world-class article.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your ENTIRE response MUST be a single, valid JSON object. No text before or after.
2.  **FRESHNESS & ACCURACY:** The entire plan MUST be based on current, fact-checked, and accurate information, with a forward-looking perspective (2025 and beyond).
3.  **DO NOT WRITE THE ARTICLE BODY:** Your role is to plan, not write. The 'outline' should be a list of H2 headings ONLY. The 'introduction' and 'conclusion' sections should be fully written paragraphs.
4.  **HEADINGS ARE SACRED (FOR VOICE & SNIPPETS):**
    - The H2 headings in the 'outline' MUST be phrased as direct user questions (e.g., "How Do I...?").
    - If provided, you MUST prioritize using the 'People Also Ask' questions for the outline. This is critical for ranking.
5.  **STRATEGIC ANALYSIS IS LAW:** If a strategic rewrite analysis is provided, you MUST incorporate ALL of its recommendations into the new title, outline, and metadata. This is your highest priority and overrides all other instructions.
6.  **WRITING STYLE (For Intro/Conclusion):** Follow the "ANTI-AI" protocol: Short, direct sentences (avg. 10 words). Tiny paragraphs (2-3 sentences max). Active voice. Your writing MUST achieve a Flesch-Kincaid readability score of 80 or higher.
    - **PRIMARY KEYWORD:** You MUST seamlessly integrate the primary keyword within the first 1-2 sentences of the introduction.
7.  **STRUCTURAL REQUIREMENTS:**
    - **keyTakeaways**: Exactly 8 high-impact bullet points (as an array of strings).
    - **outline**: 10-15 H2 headings, phrased as questions (as an array of strings).
    - **faqSection**: Exactly 8 questions for a dedicated FAQ section (as an array of objects: \`[{ "question": "..." }]\`).
    - **imageDetails**: Exactly 2 image prompts. Placeholders MUST be '[IMAGE_1_PLACEHOLDER]' and '[IMAGE_2_PLACEHOLDER]'. The 'prompt' MUST be a vivid, detailed description for an AI image generator. The 'altText' MUST be a highly descriptive, SEO-friendly sentence that explains the image's content for accessibility.
8.  **SOTA SEO METADATA:** The 'title' MUST be under 60 characters and contain the **exact** primary keyword. The 'metaDescription' MUST be between 120 and 155 characters and contain the **exact** primary keyword.
9.  **JSON STRUCTURE:** Adhere strictly to the provided JSON schema. Ensure all fields are present.
`,
        userPrompt: (primaryKeyword: string, semanticKeywords: string[] | null, serpData: any[] | null, peopleAlsoAsk: string[] | null, existingPages: any[] | null, originalContent: string | null = null, analysis: SitemapPage['analysis'] | null = null) => {
            const MAX_CONTENT_CHARS = 8000;
            const MAX_LINKING_PAGES = 50;
            const MAX_SERP_SNIPPET_LENGTH = 200;

            let contentForPrompt = originalContent 
                ? `***CRITICAL REWRITE MANDATE:*** You are to deconstruct the following outdated article and rebuild its plan.
<original_content_to_rewrite>
${originalContent.substring(0, MAX_CONTENT_CHARS)}
</original_content_to_rewrite>`
                : '';
            
            let analysisForPrompt = analysis
                ? `***CRITICAL REWRITE ANALYSIS:*** You MUST follow these strategic recommendations to improve the article. This is your highest priority.
<rewrite_plan>
${JSON.stringify(analysis, null, 2)}
</rewrite_plan>`
                : '';

            return `
**PRIMARY KEYWORD:** "${primaryKeyword}"
${analysisForPrompt}
${contentForPrompt}
${semanticKeywords ? `**MANDATORY SEMANTIC KEYWORDS:** You MUST integrate these into the outline headings: <semantic_keywords>${JSON.stringify(semanticKeywords)}</semantic_keywords>` : ''}
${peopleAlsoAsk && peopleAlsoAsk.length > 0 ? `**CRITICAL - PEOPLE ALSO ASK:** These are real user questions. You MUST use these as H2 headings in the outline. This is a top priority. <people_also_ask>${JSON.stringify(peopleAlsoAsk)}</people_also_ask>` : ''}
${serpData ? `**SERP COMPETITOR DATA:** Analyze for gaps. <serp_data>${JSON.stringify(serpData.map(d => ({title: d.title, link: d.link, snippet: d.snippet?.substring(0, MAX_SERP_SNIPPET_LENGTH)})))}</serp_data>` : ''}
${existingPages && existingPages.length > 0 ? `**INTERNAL LINKING TARGETS (for context):** <existing_articles_for_linking>${JSON.stringify(existingPages.slice(0, MAX_LINKING_PAGES).map(p => ({slug: p.slug, title: p.title})).filter(p => p.slug && p.title))}</existing_articles_for_linking>` : ''}

Generate the complete JSON plan.
`;
        }
    },
    write_article_section: {
        systemInstruction: `You are an ELITE content writer, writing in the style of a world-class thought leader like Alex Hormozi. Your SOLE task is to write the content for a single section of a larger article, based on the provided heading.

**RULES:**
1.  **RAW HTML OUTPUT:** Your response must be ONLY the raw HTML content for the section. NO JSON, NO MARKDOWN, NO EXPLANATIONS. Start directly with a \`<p>\` tag. Do not include the \`<h2>\` tag for the main heading; it will be added automatically.
2.  **ANSWER FIRST (FOR SNIPPETS):** The very first paragraph MUST be a direct, concise answer (40-55 words) to the question in the section heading.
3.  **WORD COUNT:** The entire section MUST be between 250 and 300 words. This is mandatory.
4.  **ELITE WRITING STYLE (THE "ANTI-AI" PROTOCOL):**
    - Short, direct sentences. Average 10 words. Max 15.
    - Tiny paragraphs. 2-3 sentences. MAXIMUM.
    - Your writing MUST be clear enough to achieve a Flesch-Kincaid readability score of 80 or higher (Easy to read for a 12-year-old).
    - Use contractions: "it's," "you'll," "can't."
    - Active voice. Simple language. No filler words.
5.  **FRESHNESS RULE:** All information, stats, and examples MUST be current and forward-looking (2025 and beyond). Outdated information is forbidden.
6.  **FORBIDDEN PHRASES (ZERO TOLERANCE):**
    - ❌ 'delve into', 'in today's digital landscape', 'revolutionize', 'game-changer', 'unlock', 'leverage', 'in conclusion', 'to summarize', 'utilize', 'furthermore', 'moreover', 'landscape', 'realm', 'dive deep', etc.
7.  **STRUCTURE & SEO:**
    - You MAY use \`<h3>\` tags for sub-headings.
    - You MUST include at least one HTML table (\`<table>\`), list (\`<ul>\`/\`<ol>\`), or blockquote (\`<blockquote>\`) if relevant to the topic.
    - You MUST integrate the primary keyword at least once, and relevant semantic keywords naturally.
    - You MUST naturally integrate 1-2 internal link placeholders where contextually appropriate: \`[INTERNAL_LINK slug="example-slug" text="anchor text"]\`.
    - If writing for a section where a video will be embedded, provide a brief text summary of what the video covers.
    - **E-E-A-T & CITATIONS:** Your writing MUST be backed by evidence. You MUST invent and insert citations from credible, but fictional, sources (academic journals, industry reports, government data). Use sequential, numeric in-text citations like \`[1]\`, \`[2]\`, etc. Each section should contain at least 1-2 unique citations to contribute to a total of 12+ for the article.
`,
        userPrompt: (primaryKeyword: string, articleTitle: string, sectionHeading: string, existingPages: any[] | null) => `
**Primary Keyword:** "${primaryKeyword}"
**Main Article Title:** "${articleTitle}"
**Section to Write:** "${sectionHeading}"

${existingPages && existingPages.length > 0 ? `**Available Internal Links:** You can link to these pages.
<pages>${JSON.stringify(existingPages.slice(0, 50).map(p => ({slug: p.slug, title: p.title})))}</pages>` : ''}

Write the HTML content for this section now.
`
    },
    write_faq_answer: {
        systemInstruction: `You are an expert content writer. Your task is to provide a clear, concise, and helpful answer to a single FAQ question.

**RULES:**
1.  **RAW HTML PARAGRAPH:** Respond with ONLY the answer wrapped in a single \`<p>\` tag. Do not repeat the question.
2.  **STYLE & FRESHNESS:** The answer must be direct, easy to understand (Flesch-Kincaid score of 80+), and typically 2-4 sentences long. All information must be up-to-date (2025+). Follow the "ANTI-AI" writing style (simple words, active voice).
`,
        userPrompt: (question: string) => `Question: "${question}"`
    },
    semantic_keyword_generator: {
        systemInstruction: `You are a world-class SEO analyst. Your task is to generate a comprehensive list of semantic and LSI (Latent Semantic Indexing) keywords related to a primary topic. These keywords should cover sub-topics, user intent variations, and related entities.

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object. Do not include any text, markdown, or justification before or after the JSON.
2.  **FRESHNESS:** Keywords should be relevant for the current year and beyond (2025+).
3.  **Quantity:** Generate between 15 and 25 keywords.
4.  **JSON Structure:** The JSON object must conform to this exact structure:
    {
      "semanticKeywords": [
        "A highly relevant LSI keyword.",
        "A long-tail question-based keyword.",
        "Another related keyword or phrase.",
        "..."
      ]
    }

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object, starting with { and ending with }. Do not add any introductory text, closing remarks, or markdown code fences. Your output will be parsed directly by a machine.`,
        userPrompt: (primaryKeyword: string) => `Generate semantic keywords for the primary topic: "${primaryKeyword}".`
    },
    seo_metadata_generator: {
        systemInstruction: `You are a world-class SEO copywriter with a deep understanding of Google's ranking factors and user psychology. Your task is to generate a highly optimized SEO title and meta description that maximizes click-through-rate (CTR) and ranking potential.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your entire response MUST be a single, valid JSON object: \`{ "seoTitle": "...", "metaDescription": "..." }\`. No text before or after.
2.  **FRESHNESS:** All copy must be current and forward-looking. Use the current year or next year (e.g., 2025) if it makes sense.
3.  **SEO Title (STRICTLY max 60 chars):**
    - MUST contain the primary keyword, preferably near the beginning.
    - MUST be compelling and create curiosity or urgency. Use power words.
    - MUST be unique and stand out from the provided competitor titles.
4.  **Meta Description (STRICTLY 120-155 chars):**
    - MUST contain the primary keyword and relevant semantic keywords.
    - MUST be an engaging summary of the article's value proposition.
    - MUST include a clear call-to-action (e.g., "Learn how," "Discover the secrets," "Find out more").
5.  **Geo-Targeting:** If a location is provided, you MUST naturally incorporate it into both the title and meta description.
6.  **Competitor Analysis:** Analyze the provided SERP competitor titles to identify patterns and find an angle to differentiate your metadata.
`,
        userPrompt: (primaryKeyword: string, contentSummary: string, targetAudience: string, competitorTitles: string[], location: string | null) => `
**Primary Keyword:** "${primaryKeyword}"
**Article Summary:** "${contentSummary}"
**Target Audience:** "${targetAudience}"
${location ? `**Geo-Target:** "${location}"` : ''}
**Competitor Titles (for differentiation):** ${JSON.stringify(competitorTitles)}

Generate the JSON for the SEO Title and Meta Description.
`
    },
    internal_link_optimizer: {
        systemInstruction: `You are an expert SEO content strategist. Your task is to enrich the provided article text by strategically inserting new, relevant internal links from a supplied list of pages.

**RULES:**
1.  **DO NOT ALTER CONTENT:** You MUST NOT change the existing text, headings, or structure in any way. Your ONLY job is to add internal link placeholders.
2.  **PLACEHOLDER FORMAT:** Insert links using this exact format: \`[INTERNAL_LINK slug="the-exact-slug-from-the-list" text="the-anchor-text-from-the-content"]\`.
3.  **RELEVANCE IS KEY:** Only add links where they are highly relevant and provide value to the reader. Find natural anchor text within the existing content.
4.  **QUANTITY:** Add between 5 and 10 new internal links if suitable opportunities exist.
5.  **RAW HTML OUTPUT:** Your response must be ONLY the raw HTML content with the added placeholders. NO JSON, NO MARKDOWN, NO EXPLANATIONS.
`,
        userPrompt: (content: string, availablePages: any[]) => `
**Article Content to Analyze:**
<content>
${content}
</content>

**Available Pages for Linking (use these exact slugs):**
<pages>
${JSON.stringify(availablePages.map(p => ({ slug: p.slug, title: p.title })))}
</pages>

Return the complete article content with the new internal link placeholders now.
`
    },
    find_real_references: {
        systemInstruction: `You are an expert academic research assistant. Your task is to find credible, relevant, and publicly accessible sources for an article using Google Search.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your response MUST be a single, valid JSON object. No text before or after.
2.  **USE SEARCH RESULTS:** You MUST base your findings on the provided Google Search results to ensure link validity.
3.  **REAL, CLICKABLE LINKS:** Every source MUST have a direct, fully-functional URL. Do NOT invent URLs or DOIs. Prioritize links to academic papers (.pdf), government sites (.gov), reputable university sites (.edu), and top-tier industry publications.
4.  **QUANTITY:** Find between 8 and 12 unique sources.
5.  **JSON STRUCTURE:** The JSON object must be an array of objects, conforming to this exact structure:
    [
      {
        "title": "The full title of the source article or study.",
        "url": "The direct, clickable URL to the source.",
        "source": "The name of the publication or journal (e.g., 'The New England Journal of Medicine', 'TechCrunch').",
        "year": "The publication year as a number (e.g., 2023)."
      }
    ]

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object. Do not add any introductory text, closing remarks, or markdown code fences.`,
        userPrompt: (articleTitle: string, contentSummary: string) => `
**Article Title:** "${articleTitle}"
**Content Summary:** "${contentSummary}"

Find credible sources based on the provided search results and return them in the specified JSON format.`
    },
    find_real_references_with_context: {
        systemInstruction: `You are an expert academic research assistant. Your task is to analyze a list of search results and select the most credible, relevant, and publicly accessible sources for an article.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your response MUST be a single, valid JSON object. No text before or after.
2.  **USE PROVIDED SEARCH RESULTS ONLY:** You MUST base your findings *exclusively* on the provided JSON of search results. Do not invent sources or use external knowledge.
3.  **CREDIBILITY IS PARAMOUNT:** Prioritize links from academic journals (.pdf), government sites (.gov), reputable university sites (.edu), and top-tier industry publications with clear authorship. AVOID blogs, forums, and low-quality content farms.
4.  **REAL, CLICKABLE LINKS:** Every source MUST have a direct, fully-functional URL taken directly from the 'link' field of the provided search results.
5.  **QUANTITY:** Select between 8 and 12 unique sources from the list.
6.  **JSON STRUCTURE:** The JSON object must be an array of objects, conforming to this exact structure:
    [
      {
        "title": "The full title of the source article or study.",
        "url": "The direct, clickable URL to the source.",
        "source": "The name of the publication or journal (e.g., 'The New England Journal of Medicine', 'TechCrunch'). You may need to infer this from the title or URL.",
        "year": "The publication year as a number (e.g., 2023). If not available in the search result, you may infer a recent year or omit the field."
      }
    ]

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object. Do not add any introductory text, closing remarks, or markdown code fences.`,
        userPrompt: (articleTitle: string, contentSummary: string, searchResults: any[]) => `
**Article Title:** "${articleTitle}"
**Content Summary:** "${contentSummary}"
**Search Results to Analyze:**
${JSON.stringify(searchResults)}

Select the best sources from the provided search results and return them in the specified JSON format.`
    },
    content_rewrite_analyzer: {
        systemInstruction: `You are a world-class SEO and content strategist with a proven track record of getting articles to rank #1 on Google. Your task is to perform a critical analysis of an existing blog post and provide a strategic, actionable plan to elevate it to the highest possible standard for organic traffic, SERP rankings, and AI visibility (for models like Gemini and Google's SGE).

**RULES:**
1.  **Output Format:** Your ENTIRE response MUST be a single, valid JSON object. Do not include any text, markdown, or justification before or after the JSON.
2.  **Be Critical & Specific:** Do not give generic advice. Provide concrete, actionable feedback based on the provided text.
3.  **Focus on the Goal:** Every suggestion must directly contribute to ranking #1, boosting traffic, and improving helpfulness.
4.  **JSON Structure:** Adhere strictly to the following structure:
    {
      "critique": "A concise, 2-3 sentence overall critique of the current content's strengths and weaknesses.",
      "suggestions": {
        "title": "A new, highly optimized SEO title (max 60 chars) designed for maximum CTR.",
        "contentGaps": [
          "A specific topic or user question that is missing and should be added.",
          "Another key piece of information needed to make the article comprehensive.",
          "..."
        ],
        "freshness": "Identify specific outdated information (e.g., old stats, dates like 2023 or 2024, product versions) and suggest the exact, up-to-date information that should replace it for 2025 and beyond. Be specific. If none, state 'Content appears fresh.'",
        "eeat": "Provide 2-3 specific recommendations to boost Experience, Expertise, Authoritativeness, and Trust. Examples: 'Add a quote from a named industry expert on [topic]', 'Cite a specific study from [reputable source] to back up the claim about [claim]', 'Update the author bio to highlight specific experience in this field.'"
      }
    }`,
    userPrompt: (title: string, content: string) => `Analyze the following blog post.\n\n**Title:** "${title}"\n\n**Content:**\n<content>\n${content}\n</content>`
    },
    content_health_analyzer: {
        systemInstruction: `You are an expert SEO content auditor. Your task is to analyze the provided text from a blog post and assign it a "Health Score". A low score indicates the content is thin, outdated, poorly structured, or not helpful, signaling an urgent need for an update.

**Evaluation Criteria:**
*   **Content Depth & Helpfulness (40%):** How thorough is the content? Does it seem to satisfy user intent? Is it just surface-level, or does it provide real value?
*   **Readability & Structure (30%):** Is it well-structured with clear headings? Are paragraphs short and scannable? Is the language complex or easy to read?
*   **Engagement Potential (15%):** Does it use lists, bullet points, or other elements that keep a reader engaged?
*   **Freshness Signals (15%):** Does the content feel current, or does it reference outdated concepts, statistics, or years?

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object. Do not include any text, markdown, or justification before or after the JSON.
2.  **Health Score:** The 'healthScore' must be an integer between 0 and 100.
3.  **Update Priority:** The 'updatePriority' must be one of: "Critical" (score 0-25), "High" (score 26-50), "Medium" (score 51-75), or "Healthy" (score 76-100).
4.  **Justification:** Provide a concise, one-sentence explanation for your scoring in the 'justification' field.
5.  **JSON Structure:**
    {
      "healthScore": 42,
      "updatePriority": "High",
      "justification": "The content covers the topic superficially and lacks clear structure, making it difficult to read."
    }

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object, starting with { and ending with }. Do not add any introductory text, closing remarks, or markdown code fences. Your output will be parsed directly by a machine.`,
        userPrompt: (content: string) => `Analyze the following blog post content and provide its SEO health score.\n\n&lt;content&gt;\n${content}\n&lt;/content&gt;`
    }
};

type ContentItem = {
    id: string;
    title: string;
    type: 'pillar' | 'cluster' | 'standard' | 'link-optimizer';
    status: 'idle' | 'generating' | 'done' | 'error';
    statusText: string;
    generatedContent: GeneratedContent | null;
    crawledContent: string | null;
    originalUrl?: string;
    analysis?: SitemapPage['analysis'];
};

type SeoCheck = {
    id: string;
    valid: boolean;
    text: string;
    value: string | number;
    category: 'Meta' | 'Content' | 'Accessibility';
    priority: 'High' | 'Medium' | 'Low';
    advice: string;
};

// --- REDUCER for items state ---
type ItemsAction =
    | { type: 'SET_ITEMS'; payload: Partial<ContentItem>[] }
    | { type: 'UPDATE_STATUS'; payload: { id: string; status: ContentItem['status']; statusText: string } }
    | { type: 'SET_CONTENT'; payload: { id: string; content: GeneratedContent } }
    | { type: 'SET_CRAWLED_CONTENT'; payload: { id: string; content: string } };

const itemsReducer = (state: ContentItem[], action: ItemsAction): ContentItem[] => {
    switch (action.type) {
        case 'SET_ITEMS':
            return action.payload.map((item: any) => ({ ...item, status: 'idle', statusText: 'Not Started', generatedContent: null, crawledContent: item.crawledContent || null, analysis: item.analysis || null }));
        case 'UPDATE_STATUS':
            return state.map(item =>
                item.id === action.payload.id
                    ? { ...item, status: action.payload.status, statusText: action.payload.statusText }
                    : item
            );
        case 'SET_CONTENT':
            return state.map(item =>
                item.id === action.payload.id
                    ? { ...item, status: 'done', statusText: 'Completed', generatedContent: action.payload.content }
                    : item
            );
        case 'SET_CRAWLED_CONTENT':
             return state.map(item =>
                item.id === action.payload.id
                    ? { ...item, crawledContent: action.payload.content }
                    : item
            );
        default:
            return state;
    }
};

// --- Child Components ---

const CheckIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
);

const XIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
);


const SidebarNav = memo(({ activeView, onNavClick }: { activeView: string; onNavClick: (view: string) => void; }) => {
    const navItems = [
        { id: 'setup', name: 'Setup' },
        { id: 'strategy', name: 'Content Strategy' },
        { id: 'review', name: 'Review & Export' }
    ];
    return (
        <nav aria-label="Main navigation">
            <ul className="sidebar-nav">
                {navItems.map((item) => (
                    <li key={item.id}>
                        <button
                            className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                            onClick={() => onNavClick(item.id)}
                            aria-current={activeView === item.id}
                        >
                            <span className="nav-item-name">{item.name}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
});


interface ApiKeyInputProps {
    provider: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    status: 'idle' | 'validating' | 'valid' | 'invalid';
    name?: string;
    placeholder?: string;
    isTextArea?: boolean;
    isEditing: boolean;
    onEdit: () => void;
    type?: 'text' | 'password';
}
const ApiKeyInput = memo(({ provider, value, onChange, status, name, placeholder, isTextArea, isEditing, onEdit, type = 'password' }: ApiKeyInputProps) => {
    const InputComponent = isTextArea ? 'textarea' : 'input';

    if (status === 'valid' && !isEditing) {
        return (
            <div className="api-key-group">
                <input type="text" readOnly value={`**** **** **** ${value.slice(-4)}`} />
                <button onClick={onEdit} className="btn-edit-key" aria-label={`Edit ${provider} API Key`}>Edit</button>
            </div>
        );
    }

    const commonProps = {
        name: name || `${provider}ApiKey`,
        value: value,
        onChange: onChange,
        placeholder: placeholder || `Enter your ${provider.charAt(0).toUpperCase() + provider.slice(1)} API Key`,
        'aria-invalid': status === 'invalid',
        'aria-describedby': `${provider}-status`,
        ...(isTextArea ? { rows: 4 } : { type: type })
    };

    return (
        <div className="api-key-group">
            <InputComponent {...commonProps} />
            <div className="key-status-icon" id={`${provider}-status`} role="status">
                {status === 'validating' && <div className="key-status-spinner" aria-label="Validating key"></div>}
                {status === 'valid' && <span className="success"><CheckIcon /></span>}
                {status === 'invalid' && <span className="error"><XIcon /></span>}
            </div>
        </div>
    );
});

// --- START: Advanced Content Quality Analysis ---
const countSyllables = (word: string): number => {
    if (!word) return 0;
    word = word.toLowerCase().trim();
    if (word.length <= 3) { return 1; }
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    const matches = word.match(/[aeiouy]{1,2}/g);
    return matches ? matches.length : 0;
};

const calculateFleschReadability = (text: string): number => {
    const sentences = (text.match(/[.!?]+/g) || []).length || 1;
    const words = (text.match(/\b\w+\b/g) || []).length;
    if (words < 100) return 0; // Not enough content for an accurate score

    let syllableCount = 0;
    text.split(/\s+/).forEach(word => {
        syllableCount += countSyllables(word);
    });

    const fleschScore = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllableCount / words);
    return Math.round(Math.min(100, Math.max(0, fleschScore)));
};

const getReadabilityVerdict = (score: number): { verdict: string; color: string; advice: string } => {
    if (score === 0) return { verdict: 'N/A', color: 'var(--text-tertiary)', advice: 'Not enough content to calculate a score.' };
    if (score >= 90) return { verdict: 'Very Easy', color: 'var(--success)', advice: 'Easily readable by an average 11-year-old student. Excellent.' };
    if (score >= 70) return { verdict: 'Easy', color: 'var(--success)', advice: 'Easily understood by 13- to 15-year-old students. Great for most audiences.' };
    if (score >= 60) return { verdict: 'Standard', color: 'var(--success)', advice: 'Easily understood by 13- to 15-year-old students. Good.' };
    if (score >= 50) return { verdict: 'Fairly Difficult', color: 'var(--warning)', advice: 'Can be understood by high school seniors. Consider simplifying.' };
    if (score >= 30) return { verdict: 'Difficult', color: 'var(--error)', advice: 'Best understood by college graduates. Too complex for a general audience.' };
    return { verdict: 'Very Confusing', color: 'var(--error)', advice: 'Best understood by university graduates. Very difficult to read.' };
};
// --- END: Advanced Content Quality Analysis ---

interface RankGuardianProps {
    item: ContentItem;
    editedSeo: { title: string; metaDescription: string; slug: string };
    editedContent: string;
    onSeoChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRegenerate: (field: 'title' | 'meta') => void;
    isRegenerating: { title: boolean; meta: boolean };
    isUpdate: boolean;
    geoTargeting: ExpandedGeoTargeting;
}

const RankGuardian = memo(({ item, editedSeo, editedContent, onSeoChange, onUrlChange, onRegenerate, isRegenerating, isUpdate, geoTargeting }: RankGuardianProps) => {
    const { title, metaDescription, slug } = editedSeo;
    const { primaryKeyword, semanticKeywords } = item.generatedContent!;

    const analysis = useMemo(() => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = editedContent || '';
        const textContent = tempDiv.textContent || '';
        const wordCount = (textContent.match(/\b\w+\b/g) || []).length;
        const keywordLower = primaryKeyword.toLowerCase();
        
        const contentAnalysis = {
            wordCount,
            readabilityScore: calculateFleschReadability(textContent),
            keywordDensity: (textContent.toLowerCase().match(new RegExp(escapeRegExp(keywordLower), 'g')) || []).length,
            semanticKeywordCount: semanticKeywords.reduce((acc, kw) => acc + (textContent.toLowerCase().match(new RegExp(escapeRegExp(kw.toLowerCase()), 'g')) || []).length, 0),
            linkCount: tempDiv.getElementsByTagName('a').length,
            tableCount: tempDiv.getElementsByTagName('table').length,
            listCount: tempDiv.querySelectorAll('ul, ol').length,
        };

        const checks: SeoCheck[] = [
            // Meta
            { id: 'titleLength', valid: title.length > 30 && title.length <= 60, value: title.length, text: 'Title Length (30-60)', category: 'Meta', priority: 'High', advice: 'Titles between 30 and 60 characters have the best click-through rates on Google.' },
            { id: 'titleKeyword', valid: title.toLowerCase().includes(keywordLower), value: title.toLowerCase().includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in Title', category: 'Meta', priority: 'High', advice: 'Including your primary keyword in the SEO title is crucial for relevance.' },
            { id: 'metaLength', valid: metaDescription.length >= 120 && metaDescription.length <= 155, value: metaDescription.length, text: 'Meta Description (120-155)', category: 'Meta', priority: 'Medium', advice: 'Write a meta description between 120 and 155 characters to avoid truncation and maximize CTR.' },
            { id: 'metaKeyword', valid: metaDescription.toLowerCase().includes(keywordLower), value: metaDescription.toLowerCase().includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in Meta', category: 'Meta', priority: 'High', advice: 'Your meta description should contain the primary keyword to improve click-through rate.' },
            
            // Content
            { id: 'wordCount', valid: wordCount >= 1500, value: wordCount, text: 'Word Count (1500+)', category: 'Content', priority: 'Medium', advice: 'Long-form content tends to rank better for competitive keywords. Aim for comprehensive coverage.' },
            { id: 'keywordDensity', valid: contentAnalysis.keywordDensity > 0, value: `${contentAnalysis.keywordDensity} time(s)`, text: 'Keyword Usage', category: 'Content', priority: 'High', advice: 'Using your primary keyword ensures the topic is clear to search engines.' },
            { id: 'keywordInFirstP', valid: (tempDiv.querySelector('p')?.textContent?.toLowerCase() || '').includes(keywordLower), value: (tempDiv.querySelector('p')?.textContent?.toLowerCase() || '').includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in First Paragraph', category: 'Content', priority: 'High', advice: 'Placing your keyword in the first 100 words signals the topic to search engines early.' },
            { id: 'h1s', valid: tempDiv.getElementsByTagName('h1').length === 0, value: tempDiv.getElementsByTagName('h1').length, text: 'H1 Tags in Content', category: 'Content', priority: 'High', advice: 'Your content body should not contain any H1 tags. The article title serves as the only H1.' },
            { id: 'links', valid: contentAnalysis.linkCount >= MIN_INTERNAL_LINKS, value: contentAnalysis.linkCount, text: `Internal Links (${MIN_INTERNAL_LINKS}+)`, category: 'Content', priority: 'Medium', advice: 'A strong internal linking structure helps Google understand your site architecture and topic clusters.' },
            { id: 'structuredData', valid: contentAnalysis.tableCount > 0 || contentAnalysis.listCount > 0, value: `${contentAnalysis.tableCount} tables, ${contentAnalysis.listCount} lists`, text: 'Use of Structured Data', category: 'Content', priority: 'Low', advice: 'Using tables and lists helps break up text and can lead to featured snippets.' },
            
            // Accessibility
            { id: 'altText', valid: tempDiv.querySelectorAll('img:not([alt]), img[alt=""]').length === 0, value: `${tempDiv.querySelectorAll('img:not([alt]), img[alt=""]').length} missing`, text: 'Image Alt Text', category: 'Accessibility', priority: 'Medium', advice: 'All images need descriptive alt text for screen readers and SEO.' },
        ];
        
        return { contentAnalysis, checks };

    }, [title, metaDescription, primaryKeyword, editedContent, semanticKeywords]);
    
    const { contentAnalysis, checks } = analysis;
    const readabilityVerdict = getReadabilityVerdict(contentAnalysis.readabilityScore);

    const scores = useMemo(() => {
        const totalChecks = checks.length;
        const validChecks = checks.filter(c => c.valid).length;
        const seoScore = totalChecks > 0 ? Math.round((validChecks / totalChecks) * 100) : 100;
        const overallScore = Math.round(seoScore * 0.7 + contentAnalysis.readabilityScore * 0.3);
        return { seoScore, overallScore };
    }, [checks, contentAnalysis.readabilityScore]);
    
    const actionItems = checks.filter(c => !c.valid).sort((a, b) => {
        const priorityOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    const ScoreGauge = ({ score, size = 80 }: { score: number; size?: number }) => {
        const radius = size / 2 - 5;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (score / 100) * circumference;
        let strokeColor = 'var(--success)';
        if (score < 75) strokeColor = 'var(--warning)';
        if (score < 50) strokeColor = 'var(--error)';

        return (
            <div className="score-gauge" style={{ width: size, height: size }}>
                <svg className="score-gauge-svg" viewBox={`0 0 ${size} ${size}`}>
                    <circle className="gauge-bg" cx={size/2} cy={size/2} r={radius} />
                    <circle className="gauge-fg" cx={size/2} cy={size/2} r={radius} stroke={strokeColor} strokeDasharray={circumference} strokeDashoffset={offset} />
                </svg>
                <span className="score-gauge-text" style={{ color: strokeColor }}>{score}</span>
            </div>
        );
    };
    
    const titleLength = title.length;
    const titleStatus = titleLength > 60 ? 'bad' : titleLength > 50 ? 'warn' : 'good';
    const metaLength = metaDescription.length;
    const metaStatus = metaLength > 155 ? 'bad' : metaLength > 120 ? 'warn' : 'good';

    return (
        <div className="rank-guardian-reloaded">
             <div className="guardian-header">
                <div className="guardian-main-score">
                    <ScoreGauge score={scores.overallScore} size={100} />
                    <div className="main-score-text">
                        <h4>Overall Score</h4>
                        <p>A combined metric of your on-page SEO and readability.</p>
                    </div>
                </div>
                <div className="guardian-sub-scores">
                    <div className="guardian-sub-score">
                        <ScoreGauge score={scores.seoScore} size={70}/>
                        <div className="sub-score-text">
                            <h5>SEO</h5>
                            <span>{scores.seoScore}/100</span>
                        </div>
                    </div>
                     <div className="guardian-sub-score">
                        <ScoreGauge score={contentAnalysis.readabilityScore}  size={70}/>
                        <div className="sub-score-text">
                            <h5>Readability</h5>
                            <span style={{color: readabilityVerdict.color}}>{readabilityVerdict.verdict}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="guardian-grid">
                <div className="guardian-card">
                     <h4>SERP Preview & Metadata</h4>
                     <div className="serp-preview-container">
                        <div className="serp-preview">
                            <div className="serp-url">{formatSerpUrl(slug)}</div>
                            <h3 className="serp-title">{title}</h3>
                            <div className="serp-description">{metaDescription}</div>
                        </div>
                    </div>
                     <div className="seo-inputs" style={{marginTop: '1.5rem'}}>
                        <div className="form-group">
                            <div className="label-wrapper">
                                <label htmlFor="title">SEO Title</label>
                                 <button className="btn-regenerate" onClick={() => onRegenerate('title')} disabled={isRegenerating.title}>
                                    {isRegenerating.title ? <div className="spinner"></div> : 'Regenerate'}
                                </button>
                                <span className={`char-counter ${titleStatus}`}>{titleLength} / 60</span>
                            </div>
                            <input type="text" id="title" name="title" value={title} onChange={onSeoChange} />
                            <div className="progress-bar-container">
                            <div className={`progress-bar-fill ${titleStatus}`} style={{ width: `${Math.min(100, (titleLength / 60) * 100)}%` }}></div>
                            </div>
                        </div>
                        <div className="form-group">
                            <div className="label-wrapper">
                                <label htmlFor="metaDescription">Meta Description</label>
                                <button className="btn-regenerate" onClick={() => onRegenerate('meta')} disabled={isRegenerating.meta}>
                                    {isRegenerating.meta ? <div className="spinner"></div> : 'Regenerate'}
                                </button>
                                <span className={`char-counter ${metaStatus}`}>{metaLength} / 155</span>
                            </div>
                            <textarea id="metaDescription" name="metaDescription" rows={3} value={metaDescription} onChange={onSeoChange}></textarea>
                            <div className="progress-bar-container">
                            <div className={`progress-bar-fill ${metaStatus}`} style={{ width: `${Math.min(100, (metaLength / 155) * 100)}%` }}></div>
                            </div>
                        </div>
                        <div className="form-group">
                            <label htmlFor="slug">Full URL</label>
                            <input type="text" id="slug" name="slug" value={slug} onChange={onUrlChange} disabled={isUpdate} />
                        </div>
                    </div>
                </div>
                
                 <div className="guardian-card">
                    <h4>Actionable Checklist</h4>
                     {actionItems.length === 0 ? (
                        <div className="all-good">
                            <span role="img" aria-label="party popper">🎉</span> All checks passed! This is looking great.
                        </div>
                    ) : (
                        <ul className="action-item-list">
                            {actionItems.map(item => (
                                <li key={item.id} className={`priority-${item.priority}`}>
                                    <h5>{item.text}</h5>
                                    <p>{item.advice}</p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                
                <div className="guardian-card">
                    <h4>Content Analysis</h4>
                    <ul className="guardian-checklist">
                       {checks.map(check => (
                           <li key={check.id}>
                                <div className={`check-icon-guardian ${check.valid ? 'valid' : 'invalid'}`}>
                                    {check.valid ? <CheckIcon /> : <XIcon />}
                                </div>
                                <div>
                                    <div className="check-text-guardian">{check.text}</div>
                                    <div className="check-advice-guardian">{check.advice}</div>
                                </div>
                           </li>
                       ))}
                    </ul>
                </div>

            </div>
        </div>
    );
});


const SkeletonLoader = ({ rows = 5, columns = 5 }: { rows?: number, columns?: number }) => (
    <tbody>
        {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="skeleton-row">
                {Array.from({ length: columns }).map((_, j) => (
                    <td key={j}><div className="skeleton-loader"></div></td>
                ))}
            </tr>
        ))}
    </tbody>
);

const Confetti = () => {
    const [pieces, setPieces] = useState<React.ReactElement[]>([]);

    useEffect(() => {
        const newPieces = Array.from({ length: 100 }).map((_, i) => {
            const style = {
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 2}s`,
                backgroundColor: `hsl(${Math.random() * 360}, 70%, 50%)`,
                transform: `rotate(${Math.random() * 360}deg)`,
            };
            return <div key={i} className="confetti" style={style}></div>;
        });
        setPieces(newPieces);
    }, []);

    return <div className="confetti-container" aria-hidden="true">{pieces}</div>;
};

// Helper function to escape characters for use in a regular expression
const escapeRegExp = (string: string) => {
  return string.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); // $& means the whole matched string
}

// SOTA Editor syntax highlighter
const highlightHtml = (text: string): string => {
    if (!text) return '';
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Comments
    html = html.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="editor-comment">$1</span>');

    // Tags and attributes
    html = html.replace(/(&lt;\/?)([\w-]+)([^&]*?)(&gt;)/g, (match, open, tag, attrs, close) => {
        const highlightedTag = `<span class="editor-tag">${tag}</span>`;
        const highlightedAttrs = attrs.replace(/([\w-]+)=(".*?"|'.*?')/g, 
            '<span class="editor-attr-name">$1</span>=<span class="editor-attr-value">$2</span>'
        );
        return `${open}${highlightedTag}${highlightedAttrs}${close}`;
    });

    return html;
};


interface ReviewModalProps {
    item: ContentItem;
    onClose: () => void;
    onSaveChanges: (itemId: string, updatedSeo: { title: string; metaDescription: string; slug: string }, updatedContent: string) => void;
    wpConfig: { url: string, username: string };
    wpPassword: string;
    onPublishSuccess: (originalUrl: string) => void;
    publishItem: (itemToPublish: ContentItem, currentWpPassword: string, status: 'publish' | 'draft') => Promise<{ success: boolean; message: React.ReactNode; link?: string }>;
    callAI: (promptKey: keyof typeof PROMPT_TEMPLATES, promptArgs: any[], responseFormat?: 'json' | 'html', useGrounding?: boolean) => Promise<string>;
    geoTargeting: ExpandedGeoTargeting;
}

const formatSerpUrl = (fullUrl: string): React.ReactNode => {
    try {
        const url = new URL(fullUrl);
        const parts = [url.hostname, ...url.pathname.split('/').filter(Boolean)];
        
        return (
            <div className="serp-breadcrumb">
                {parts.map((part, index) => (
                    <React.Fragment key={index}>
                        <span>{part}</span>
                        {index < parts.length - 1 && <span className="breadcrumb-separator">›</span>}
                    </React.Fragment>
                ))}
            </div>
        );
    } catch (e) {
        // Fallback for invalid URLs
        return (
            <div className="serp-breadcrumb">
                <span>{fullUrl}</span>
            </div>
        );
    }
};

const ReviewModal = ({ item, onClose, onSaveChanges, wpConfig, wpPassword, onPublishSuccess, publishItem, callAI, geoTargeting }: ReviewModalProps) => {
    if (!item || !item.generatedContent) return null;

    const [activeTab, setActiveTab] = useState('Live Preview');
    const [editedSeo, setEditedSeo] = useState({ title: '', metaDescription: '', slug: '' });
    const [editedContent, setEditedContent] = useState('');
    const [copyStatus, setCopyStatus] = useState('Copy HTML');
    const [wpPublishStatus, setWpPublishStatus] = useState('idle'); // idle, publishing, success, error
    const [wpPublishMessage, setWpPublishMessage] = useState<React.ReactNode>('');
    const [publishAction, setPublishAction] = useState<'publish' | 'draft'>('publish');
    const [showConfetti, setShowConfetti] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState({ title: false, meta: false });

    // SOTA Editor State
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const lineNumbersRef = useRef<HTMLPreElement>(null);
    const highlightRef = useRef<HTMLDivElement>(null);
    const [lineCount, setLineCount] = useState(1);

    useEffect(() => {
        if (item && item.generatedContent) {
            const isUpdate = !!item.originalUrl;
            const fullUrl = isUpdate 
                ? item.originalUrl! 
                : `${wpConfig.url.replace(/\/+$/, '')}/${item.generatedContent.slug}`;
            
            setEditedSeo({
                title: item.generatedContent.title,
                metaDescription: item.generatedContent.metaDescription,
                slug: fullUrl,
            });
            setEditedContent(item.generatedContent.content);
            setActiveTab('Live Preview');
            setWpPublishStatus('idle');
            setWpPublishMessage('');
            setShowConfetti(false);
            
            // SOTA FIX: Reset editor scroll position
            if (editorRef.current) {
                editorRef.current.scrollTop = 0;
            }
        }
    }, [item, wpConfig.url]);


    // SOTA Editor Logic
    useEffect(() => {
        const lines = editedContent.split('\n').length;
        setLineCount(lines || 1);
    }, [editedContent]);

    const handleEditorScroll = useCallback(() => {
        if (lineNumbersRef.current && editorRef.current && highlightRef.current) {
            const scrollTop = editorRef.current.scrollTop;
            const scrollLeft = editorRef.current.scrollLeft;
            lineNumbersRef.current.scrollTop = scrollTop;
            highlightRef.current.scrollTop = scrollTop;
            highlightRef.current.scrollLeft = scrollLeft;
        }
    }, []);


    const previewContent = useMemo(() => {
        return editedContent;
    }, [editedContent]);

    const handleSeoChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setEditedSeo(prev => ({ ...prev, [name]: value }));
    };

    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setEditedSeo(prev => ({ ...prev, slug: e.target.value }));
    };

    const handleCopyHtml = () => {
        if (!item?.generatedContent) return;
        navigator.clipboard.writeText(editedContent)
            .then(() => {
                setCopyStatus('Copied!');
                setTimeout(() => setCopyStatus('Copy HTML'), 2000);
            })
            .catch(err => console.error('Failed to copy HTML: ', err));
    };

    const handleValidateSchema = () => {
        if (!item?.generatedContent?.jsonLdSchema) {
            alert("Schema has not been generated for this item yet.");
            return;
        }
        try {
            const schemaString = JSON.stringify(item.generatedContent.jsonLdSchema, null, 2);
            const url = `https://search.google.com/test/rich-results?code=${encodeURIComponent(schemaString)}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error("Failed to validate schema:", error);
            alert("Could not process schema for validation.");
        }
    };

    const handleDownloadImage = (base64Data: string, fileName: string) => {
        const link = document.createElement('a');
        link.href = base64Data;
        const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        link.download = `${safeName}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleRegenerateSeo = async (field: 'title' | 'meta') => {
        if (!item.generatedContent) return;
        setIsRegenerating(prev => ({ ...prev, [field]: true }));
        try {
            const { primaryKeyword, strategy, serpData } = item.generatedContent;
            const summary = editedContent.replace(/<[^>]+>/g, ' ').substring(0, 500);
            const competitorTitles = serpData?.map(d => d.title).slice(0, 5) || [];
            const location = geoTargeting.enabled ? geoTargeting.location : null;

            const responseText = await callAI('seo_metadata_generator', [
                primaryKeyword, summary, strategy.targetAudience, competitorTitles, location
            ], 'json');
            const { seoTitle, metaDescription } = JSON.parse(extractJson(responseText));

            if (field === 'title' && seoTitle) {
                setEditedSeo(prev => ({ ...prev, title: seoTitle }));
            }
            if (field === 'meta' && metaDescription) {
                setEditedSeo(prev => ({ ...prev, metaDescription: metaDescription }));
            }
        } catch (error: any) {
            console.error(`Failed to regenerate ${field}:`, error);
            alert(`An error occurred while regenerating the ${field}. Please check the console.`);
        } finally {
            setIsRegenerating(prev => ({ ...prev, [field]: false }));
        }
    };


    const handlePublishToWordPress = async () => {
        if (!wpConfig.url || !wpConfig.username || !wpPassword) {
            setWpPublishStatus('error');
            setWpPublishMessage('Please fill in WordPress URL, Username, and Application Password in Step 1.');
            return;
        }

        setWpPublishStatus('publishing');
        
        const itemWithEdits: ContentItem = {
            ...item,
            generatedContent: {
                ...item.generatedContent!,
                title: editedSeo.title,
                metaDescription: editedSeo.metaDescription,
                slug: extractSlugFromUrl(editedSeo.slug),
                content: editedContent,
            }
        };

        const result = await publishItem(itemWithEdits, wpPassword, item.originalUrl ? 'publish' : publishAction);

        if (result.success) {
            setWpPublishStatus('success');
            setShowConfetti(true);
            if (item.originalUrl) {
                onPublishSuccess(item.originalUrl);
            }
        } else {
            setWpPublishStatus('error');
        }
        setWpPublishMessage(result.message);
    };

    const TABS = ['Live Preview', 'Editor', 'Assets', 'Rank Guardian', 'Raw JSON'];
    const { primaryKeyword } = item.generatedContent;
    const isUpdate = !!item.originalUrl;

    let publishButtonText = 'Publish';
    if (isUpdate) {
        publishButtonText = 'Update Live Post';
    } else if (publishAction === 'draft') {
        publishButtonText = 'Save as Draft';
    }
    const publishingButtonText = isUpdate ? 'Updating...' : (publishAction === 'draft' ? 'Saving...' : 'Publishing...');

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
                {showConfetti && <Confetti />}
                <h2 id="review-modal-title" className="sr-only">Review and Edit Content</h2>
                <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>
                <div className="review-tabs" role="tablist">
                    {TABS.map(tab => (
                        <button key={tab} className={`tab-btn ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} aria-controls={`tab-panel-${tab.replace(/\s/g, '-')}`}>
                            {tab}
                        </button>
                    ))}
                </div>

                <div className="tab-content">
                    {activeTab === 'Live Preview' && (
                        <div id="tab-panel-Live-Preview" role="tabpanel" className="live-preview" dangerouslySetInnerHTML={{ __html: previewContent }}></div>
                    )}
                    
                    {activeTab === 'Editor' && (
                        <div id="tab-panel-Editor" role="tabpanel" className="editor-tab-container">
                            <div className="sota-editor-pro">
                                <pre className="line-numbers" ref={lineNumbersRef} aria-hidden="true">
                                    {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                                </pre>
                                <div className="editor-content-wrapper">
                                    <div
                                        ref={highlightRef}
                                        className="editor-highlight-layer"
                                        dangerouslySetInnerHTML={{ __html: highlightHtml(editedContent) }}
                                    />
                                    <textarea
                                        ref={editorRef}
                                        className="html-editor-input"
                                        value={editedContent}
                                        onChange={(e) => setEditedContent(e.target.value)}
                                        onScroll={handleEditorScroll}
                                        aria-label="HTML Content Editor"
                                        spellCheck="false"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Assets' && (
                        <div id="tab-panel-Assets" role="tabpanel" className="assets-tab-container">
                            <h3>Generated Images</h3>
                            <p className="help-text" style={{fontSize: '1rem', maxWidth: '800px', margin: '0 0 2rem 0'}}>These images are embedded in your article. They will be automatically uploaded to your WordPress media library when you publish. You can also download them for manual use.</p>
                            <div className="image-assets-grid">
                                {item.generatedContent.imageDetails.map((image, index) => (
                                    image.generatedImageSrc ? (
                                        <div key={index} className="image-asset-card">
                                            <img src={image.generatedImageSrc} alt={image.altText} loading="lazy" width="512" height="288" />
                                            <div className="image-asset-details">
                                                <p><strong>Alt Text:</strong> {image.altText}</p>
                                                <button className="btn btn-small" onClick={() => handleDownloadImage(image.generatedImageSrc!, image.title)}>Download Image</button>
                                            </div>
                                        </div>
                                    ) : null
                                ))}
                            </div>
                        </div>
                    )}

                    {activeTab === 'Rank Guardian' && (
                         <div id="tab-panel-Rank-Guardian" role="tabpanel" className="rank-guardian-container">
                            <RankGuardian 
                                item={item}
                                editedSeo={editedSeo}
                                editedContent={editedContent}
                                onSeoChange={handleSeoChange}
                                onUrlChange={handleUrlChange}
                                onRegenerate={handleRegenerateSeo}
                                isRegenerating={isRegenerating}
                                isUpdate={isUpdate}
                                geoTargeting={geoTargeting}
                            />
                        </div>
                    )}

                    {activeTab === 'Raw JSON' && (
                        <pre id="tab-panel-Raw-JSON" role="tabpanel" className="json-viewer">
                            {JSON.stringify(item.generatedContent, null, 2)}
                        </pre>
                    )}
                </div>

                <div className="modal-footer">
                    <div className="wp-publish-container">
                        {wpPublishMessage && <div className={`publish-status ${wpPublishStatus}`} role="alert" aria-live="assertive">{wpPublishMessage}</div>}
                    </div>

                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={() => onSaveChanges(item.id, editedSeo, editedContent)}>Save Changes</button>
                        <button className="btn btn-secondary" onClick={handleCopyHtml}>{copyStatus}</button>
                        <button className="btn btn-secondary" onClick={handleValidateSchema}>Validate Schema</button>
                        <div className="publish-action-group">
                            <select value={publishAction} onChange={e => setPublishAction(e.target.value as 'publish' | 'draft')} disabled={isUpdate}>
                                <option value="publish">Publish</option>
                                <option value="draft">Save as Draft</option>
                            </select>
                            <button 
                                className="btn"
                                onClick={handlePublishToWordPress}
                                disabled={wpPublishStatus === 'publishing'}
                            >
                                {wpPublishStatus === 'publishing' ? publishingButtonText : publishButtonText}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface BulkPublishModalProps {
    items: ContentItem[];
    onClose: () => void;
    publishItem: (item: ContentItem, password: string, status: 'publish' | 'draft') => Promise<{ success: boolean; message: React.ReactNode; link?: string; }>;
    wpPassword: string;
    onPublishSuccess: (originalUrl: string) => void;
}

const BulkPublishModal = ({ items, onClose, publishItem, wpPassword, onPublishSuccess }: BulkPublishModalProps) => {
    const [publishState, setPublishState] = useState<Record<string, { status: 'queued' | 'publishing' | 'success' | 'error', message: React.ReactNode }>>(() => {
        const initialState: Record<string, any> = {};
        items.forEach(item => {
            initialState[item.id] = { status: 'queued', message: 'In queue' };
        });
        return initialState;
    });
    const [isPublishing, setIsPublishing] = useState(false);
    const [isComplete, setIsComplete] = useState(false);
    const [publishAction, setPublishAction] = useState<'publish' | 'draft'>('publish');

    const handleStartPublishing = async () => {
        setIsPublishing(true);
        setIsComplete(false);
        
        await processConcurrently(
            items,
            async (item) => {
                setPublishState(prev => ({ ...prev, [item.id]: { status: 'publishing', message: 'Publishing...' } }));
                const result = await publishItem(item, wpPassword, item.originalUrl ? 'publish' : publishAction);
                setPublishState(prev => ({ ...prev, [item.id]: { status: result.success ? 'success' : 'error', message: result.message } }));
                if (result.success && item.originalUrl) {
                    onPublishSuccess(item.originalUrl);
                }
            },
            5 // Concurrently publish 5 at a time for better performance
        );

        setIsPublishing(false);
        setIsComplete(true);
    };

    const hasUpdates = items.some(item => !!item.originalUrl);

    return (
        <div className="modal-overlay" onClick={isPublishing ? undefined : onClose}>
            <div className="modal-content small-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="gradient-headline" style={{margin: '0 auto'}}>Bulk Publish to WordPress</h2>
                    {!isPublishing && <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>}
                </div>
                <div className="modal-body">
                    <p>The following {items.length} articles will be sent to your WordPress site. Please do not close this window until the process is complete.</p>
                    {hasUpdates && <p className="help-text">Note: Existing articles will always be updated, not created as new drafts.</p>}
                     <div className="form-group">
                        <label htmlFor="bulkPublishAction">Action for new articles:</label>
                        <select id="bulkPublishAction" value={publishAction} onChange={e => setPublishAction(e.target.value as 'publish' | 'draft')} disabled={isPublishing}>
                            <option value="publish">Publish Immediately</option>
                            <option value="draft">Save as Draft</option>
                        </select>
                    </div>
                    <ul className="bulk-publish-list">
                        {items.map(item => (
                            <li key={item.id} className="bulk-publish-item">
                                <span className="bulk-publish-item-title" title={item.title}>{item.title} {item.originalUrl ? '(Update)' : ''}</span>
                                <div className="bulk-publish-item-status">
                                    {publishState[item.id].status === 'queued' && <span style={{ color: 'var(--text-light-color)' }}>Queued</span>}
                                    {publishState[item.id].status === 'publishing' && <><div className="spinner"></div><span>Publishing...</span></>}
                                    {publishState[item.id].status === 'success' && <span className="success">{publishState[item.id].message}</span>}
                                    {publishState[item.id].status === 'error' && <span className="error">✗ Error</span>}
                                </div>
                            </li>
                        ))}
                    </ul>
                     {Object.values(publishState).some(s => s.status === 'error') &&
                        <div className="result error" style={{marginTop: '1.5rem'}}>
                            Some articles failed to publish. Check your WordPress credentials, ensure the REST API is enabled, and try again.
                        </div>
                    }
                </div>
                <div className="modal-footer">
                    {isComplete ? (
                        <button className="btn" onClick={onClose}>Close</button>
                    ) : (
                        <button className="btn" onClick={handleStartPublishing} disabled={isPublishing}>
                            {isPublishing ? `Sending... (${Object.values(publishState).filter(s => s.status === 'success' || s.status === 'error').length}/${items.length})` : `Send ${items.length} Articles`}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

interface AnalysisModalProps {
    page: SitemapPage;
    onClose: () => void;
    onPlanRewrite: (page: SitemapPage) => void;
}

const AnalysisModal = ({ page, onClose, onPlanRewrite }: AnalysisModalProps) => {
    const analysis = page.analysis;

    if (!analysis) return null;

    const handleRewriteClick = () => {
        onPlanRewrite(page);
        onClose();
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content analysis-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="gradient-headline" style={{ margin: 0, padding: 0 }}>Rewrite Strategy</h2>
                    <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>
                </div>
                <div className="modal-body" style={{ padding: '0 2.5rem 2rem' }}>
                    <h3 className="analysis-title">{page.title}</h3>
                    <div className="analysis-section">
                        <h4>Overall Critique</h4>
                        <p>{analysis.critique}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>Suggested SEO Title</h4>
                        <p className="suggestion-box">{analysis.suggestions.title}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>Content Gap Opportunities</h4>
                        <ul className="suggestion-list">
                            {analysis.suggestions.contentGaps.map((gap, i) => <li key={i}>{gap}</li>)}
                        </ul>
                    </div>
                     <div className="analysis-section">
                        <h4>Freshness & Accuracy Updates</h4>
                        <p>{analysis.suggestions.freshness}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>E-E-A-T Improvements</h4>
                        <p>{analysis.suggestions.eeat}</p>
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn" onClick={handleRewriteClick}>
                        Proceed with Rewrite Plan
                    </button>
                </div>
            </div>
        </div>
    );
};

const AppFooter = memo(() => (
    <footer className="app-footer">
        <div className="footer-grid">
            <div className="footer-logo-column">
                <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">
                    <img src="https://affiliatemarketingforsuccess.com/wp-content/uploads/2023/03/cropped-Affiliate-Marketing-for-Success-Logo-Edited.png?lm=6666FEE0" alt="AffiliateMarketingForSuccess.com Logo" className="footer-logo-img" />
                </a>
                <p className="footer-tagline">Empowering creators with cutting-edge tools.</p>
            </div>
             <div className="footer-column">
                <ul className="footer-links-list">
                    <li><a href="https://affiliatemarketingforsuccess.com/about/" target="_blank" rel="noopener noreferrer">About</a></li>
                    <li><a href="https://affiliatemarketingforsuccess.com/contact/" target="_blank" rel="noopener noreferrer">Contact</a></li>
                    <li><a href="https://affiliatemarketingforsuccess.com/privacy-policy/" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
                </ul>
            </div>
        </div>
    </footer>
));


// --- Main App Component ---
const App = () => {
    const [activeView, setActiveView] = useState('setup');
    
    // Step 1: API Keys & Config
    const [apiKeys, setApiKeys] = useState(() => {
        const saved = localStorage.getItem('apiKeys');
        const initialKeys = saved ? JSON.parse(saved) : { openaiApiKey: '', anthropicApiKey: '', openrouterApiKey: '', serperApiKey: '', groqApiKey: '' };
        if (initialKeys.geminiApiKey) {
            delete initialKeys.geminiApiKey;
        }
        return initialKeys;
    });
    const [apiKeyStatus, setApiKeyStatus] = useState({ gemini: 'idle', openai: 'idle', anthropic: 'idle', openrouter: 'idle', serper: 'idle', groq: 'idle' } as Record<string, 'idle' | 'validating' | 'valid' | 'invalid'>);
    const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
    const [apiClients, setApiClients] = useState<{ gemini: GoogleGenAI | null, openai: OpenAI | null, anthropic: Anthropic | null, openrouter: OpenAI | null, groq: OpenAI | null }>({ gemini: null, openai: null, anthropic: null, openrouter: null, groq: null });
    const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('selectedModel') || 'gemini');
    const [selectedGroqModel, setSelectedGroqModel] = useState(() => localStorage.getItem('selectedGroqModel') || AI_MODELS.GROQ_MODELS[0]);
    const [openrouterModels, setOpenrouterModels] = useState<string[]>(AI_MODELS.OPENROUTER_DEFAULT);
    const [geoTargeting, setGeoTargeting] = useState<ExpandedGeoTargeting>(() => {
        const saved = localStorage.getItem('geoTargeting');
        return saved ? JSON.parse(saved) : { enabled: false, location: '', region: '', country: '', postalCode: '' };
    });
    const [useGoogleSearch, setUseGoogleSearch] = useState(false);


    // Step 2: Content Strategy
    const [contentMode, setContentMode] = useState('bulk'); // 'bulk', 'single', or 'imageGenerator'
    const [topic, setTopic] = useState('');
    const [primaryKeyword, setPrimaryKeyword] = useState('');
    const [sitemapUrl, setSitemapUrl] = useState('');
    const [isCrawling, setIsCrawling] = useState(false);
    const [crawlMessage, setCrawlMessage] = useState('');
    const [crawlProgress, setCrawlProgress] = useState({ current: 0, total: 0 });
    const [existingPages, setExistingPages] = useState<SitemapPage[]>([]);
    const [wpConfig, setWpConfig] = useState<WpConfig>(() => {
        const saved = localStorage.getItem('wpConfig');
        return saved ? JSON.parse(saved) : { url: '', username: '' };
    });
    const [wpPassword, setWpPassword] = useState(() => localStorage.getItem('wpPassword') || '');
    const [wpConnectionStatus, setWpConnectionStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
    const [wpConnectionMessage, setWpConnectionMessage] = useState<React.ReactNode>('');
    const [siteInfo, setSiteInfo] = useState<SiteInfo>(() => {
        const saved = localStorage.getItem('siteInfo');
        return saved ? JSON.parse(saved) : {
            orgName: '', orgUrl: '', logoUrl: '', orgSameAs: [],
            authorName: '', authorUrl: '', authorSameAs: []
        };
    });


    // Image Generator State
    const [imagePrompt, setImagePrompt] = useState('');
    const [numImages, setNumImages] = useState(1);
    const [aspectRatio, setAspectRatio] = useState('1:1');
    const [isGeneratingImages, setIsGeneratingImages] = useState(false);
    const [generatedImages, setGeneratedImages] = useState<{ src: string, prompt: string }[]>([]); // Array of { src: string, prompt: string }
    const [imageGenerationError, setImageGenerationError] = useState('');

    // Step 3: Generation & Review
    const [items, dispatch] = useReducer(itemsReducer, []);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0 });
    const [selectedItems, setSelectedItems] = useState(new Set<string>());
    const [filter, setFilter] = useState('');
    const [sortConfig, setSortConfig] = useState({ key: 'title', direction: 'asc' });
    const [selectedItemForReview, setSelectedItemForReview] = useState<ContentItem | null>(null);
    const [isBulkPublishModalOpen, setIsBulkPublishModalOpen] = useState(false);
    const stopGenerationRef = useRef(new Set<string>());
    
    // Content Hub State
    const [hubSearchFilter, setHubSearchFilter] = useState('');
    const [hubStatusFilter, setHubStatusFilter] = useState('All');
    const [hubSortConfig, setHubSortConfig] = useState<{key: string, direction: 'asc' | 'desc'}>({ key: 'default', direction: 'desc' });
    const [isAnalyzingHealth, setIsAnalyzingHealth] = useState(false);
    const [healthAnalysisProgress, setHealthAnalysisProgress] = useState({ current: 0, total: 0 });
    const [selectedHubPages, setSelectedHubPages] = useState(new Set<string>());
    const [viewingAnalysis, setViewingAnalysis] = useState<SitemapPage | null>(null);
    
    // Web Worker
    const workerRef = useRef<Worker | null>(null);

    // --- Effects ---
    
    useEffect(() => { localStorage.setItem('apiKeys', JSON.stringify(apiKeys)); }, [apiKeys]);
    useEffect(() => { localStorage.setItem('selectedModel', selectedModel); }, [selectedModel]);
    useEffect(() => { localStorage.setItem('selectedGroqModel', selectedGroqModel); }, [selectedGroqModel]);
    useEffect(() => { localStorage.setItem('wpConfig', JSON.stringify(wpConfig)); }, [wpConfig]);
    useEffect(() => { localStorage.setItem('wpPassword', wpPassword); }, [wpPassword]);
    useEffect(() => { localStorage.setItem('geoTargeting', JSON.stringify(geoTargeting)); }, [geoTargeting]);
    useEffect(() => { localStorage.setItem('siteInfo', JSON.stringify(siteInfo)); }, [siteInfo]);

    useEffect(() => {
        (async () => {
            if (process.env.API_KEY) {
                try {
                    setApiKeyStatus(prev => ({...prev, gemini: 'validating' }));
                    const geminiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });
                    await callAiWithRetry(() => geminiClient.models.generateContent({ model: AI_MODELS.GEMINI_FLASH, contents: 'test' }));
                    setApiClients(prev => ({ ...prev, gemini: geminiClient }));
                    setApiKeyStatus(prev => ({...prev, gemini: 'valid' }));
                } catch (e) {
                    console.error("Gemini client initialization/validation failed:", e);
                    setApiClients(prev => ({ ...prev, gemini: null }));
                    setApiKeyStatus(prev => ({...prev, gemini: 'invalid' }));
                }
            } else {
                console.error("Gemini API key (API_KEY environment variable) is not set.");
                setApiClients(prev => ({ ...prev, gemini: null }));
                setApiKeyStatus(prev => ({...prev, gemini: 'invalid' }));
            }
        })();
    }, []);


    useEffect(() => {
        const workerCode = `
            self.addEventListener('message', async (e) => {
                const { type, payload } = e.data;

                const fetchWithProxies = ${fetchWithProxies.toString()};
                const extractSlugFromUrl = ${extractSlugFromUrl.toString()};

                if (type === 'CRAWL_SITEMAP') {
                    const { sitemapUrl } = payload;
                    const pageDataMap = new Map();
                    const crawledSitemapUrls = new Set();
                    const sitemapsToCrawl = [sitemapUrl];
                    
                    const onCrawlProgress = (message) => {
                        self.postMessage({ type: 'CRAWL_UPDATE', payload: { message } });
                    };

                    try {
                        onCrawlProgress('Discovering all pages from sitemap(s)...');
                        while (sitemapsToCrawl.length > 0) {
                            const currentSitemapUrl = sitemapsToCrawl.shift();
                            if (!currentSitemapUrl || crawledSitemapUrls.has(currentSitemapUrl)) continue;

                            crawledSitemapUrls.add(currentSitemapUrl);
                            
                            const response = await fetchWithProxies(currentSitemapUrl, {}, onCrawlProgress);
                            const text = await response.text();
                            
                            const initialUrlCount = pageDataMap.size;
                            const sitemapRegex = /<sitemap>\\s*<loc>(.*?)<\\/loc>\\s*<\\/sitemap>/g;
                            const urlBlockRegex = /<url>([\\s\\S]*?)<\\/url>/g;
                            let match;
                            let isSitemapIndex = false;

                            while((match = sitemapRegex.exec(text)) !== null) {
                                sitemapsToCrawl.push(match[1]);
                                isSitemapIndex = true;
                            }

                            while((match = urlBlockRegex.exec(text)) !== null) {
                                const block = match[1];
                                const locMatch = /<loc>(.*?)<\\/loc>/.exec(block);
                                if (locMatch) {
                                    const loc = locMatch[1];
                                    if (!pageDataMap.has(loc)) {
                                        const lastmodMatch = /<lastmod>(.*?)<\\/lastmod>/.exec(block);
                                        const lastmod = lastmodMatch ? lastmodMatch[1] : null;
                                        pageDataMap.set(loc, { lastmod });
                                    }
                                }
                            }

                            if (!isSitemapIndex && pageDataMap.size === initialUrlCount) {
                                onCrawlProgress(\`Using fallback parser for: \${currentSitemapUrl.substring(0, 100)}...\`);
                                const genericLocRegex = /<loc>(.*?)<\\/loc>/g;
                                while((match = genericLocRegex.exec(text)) !== null) {
                                    const loc = match[1].trim();
                                    if (loc.startsWith('http') && !pageDataMap.has(loc)) {
                                        pageDataMap.set(loc, { lastmod: null });
                                    }
                                }
                            }
                        }

                        const discoveredPages = Array.from(pageDataMap.entries()).map(([url, data]) => {
                            const currentDate = new Date();
                            let daysOld = null;
                            if (data.lastmod) {
                                const lastModDate = new Date(data.lastmod);
                                if (!isNaN(lastModDate.getTime())) {
                                    daysOld = Math.round((currentDate.getTime() - lastModDate.getTime()) / (1000 * 3600 * 24));
                                }
                            }
                            return {
                                id: url,
                                title: url,
                                slug: extractSlugFromUrl(url),
                                lastMod: data.lastmod,
                                wordCount: null,
                                crawledContent: null,
                                healthScore: null,
                                updatePriority: null,
                                justification: null,
                                daysOld: daysOld,
                                isStale: false,
                                publishedState: 'none',
                                status: 'idle',
                                analysis: null,
                            };
                        });

                        if (discoveredPages.length === 0) {
                             self.postMessage({ type: 'CRAWL_COMPLETE', payload: { pages: [], message: 'Crawl complete, but no page URLs were found.' } });
                             return;
                        }

                        self.postMessage({ type: 'CRAWL_COMPLETE', payload: { pages: discoveredPages, message: \`Discovery successful! Found \${discoveredPages.length} pages. Select pages and click 'Analyze' to process content.\` } });

                    } catch (error) {
                        self.postMessage({ type: 'CRAWL_ERROR', payload: { message: \`An error occurred during crawl: \${error.message}\` } });
                    }
                }
            });
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        workerRef.current = new Worker(URL.createObjectURL(blob));

        workerRef.current.onmessage = (e) => {
            const { type, payload } = e.data;
            switch (type) {
                case 'CRAWL_UPDATE':
                    if (payload.message) setCrawlMessage(payload.message);
                    break;
                case 'CRAWL_COMPLETE':
                    setCrawlMessage(payload.message || 'Crawl complete.');
                    setExistingPages(payload.pages as SitemapPage[] || []);
                    setIsCrawling(false);
                    break;
                case 'CRAWL_ERROR':
                    setCrawlMessage(payload.message);
                    setIsCrawling(false);
                    break;
            }
        };

        return () => {
            workerRef.current?.terminate();
        };
    }, []);

    useEffect(() => {
        setSelectedHubPages(new Set());
    }, [hubSearchFilter, hubStatusFilter]);

     const filteredAndSortedHubPages = useMemo(() => {
        let filtered = [...existingPages];

        if (hubStatusFilter !== 'All') {
            filtered = filtered.filter(page => page.updatePriority === hubStatusFilter);
        }

        if (hubSearchFilter) {
            filtered = filtered.filter(page =>
                page.title.toLowerCase().includes(hubSearchFilter.toLowerCase()) ||
                page.id.toLowerCase().includes(hubSearchFilter.toLowerCase())
            );
        }

        if (hubSortConfig.key) {
            filtered.sort((a, b) => {
                 if (hubSortConfig.key === 'default') {
                    if (a.isStale !== b.isStale) {
                        return a.isStale ? -1 : 1;
                    }
                    if (a.daysOld !== b.daysOld) {
                        return (b.daysOld ?? 0) - (a.daysOld ?? 0);
                    }
                    return (a.wordCount ?? 0) - (b.wordCount ?? 0);
                }

                let valA = a[hubSortConfig.key as keyof typeof a];
                let valB = b[hubSortConfig.key as keyof typeof b];

                if (typeof valA === 'boolean' && typeof valB === 'boolean') {
                    if (valA === valB) return 0;
                    if (hubSortConfig.direction === 'asc') {
                        return valA ? -1 : 1;
                    }
                    return valA ? 1 : -1;
                }

                if (valA === null || valA === undefined) valA = hubSortConfig.direction === 'asc' ? Infinity : -Infinity;
                if (valB === null || valB === undefined) valB = hubSortConfig.direction === 'asc' ? Infinity : -Infinity;

                if (valA < valB) {
                    return hubSortConfig.direction === 'asc' ? -1 : 1;
                }
                if (valA > valB) {
                    return hubSortConfig.direction === 'asc' ? 1 : -1;
                }
                return 0;
            });
        }


        return filtered;
    }, [existingPages, hubSearchFilter, hubStatusFilter, hubSortConfig]);

    const validateApiKey = useCallback(debounce(async (provider: string, key: string) => {
        if (!key) {
            setApiKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
            setApiClients(prev => ({ ...prev, [provider]: null }));
            return;
        }

        setApiKeyStatus(prev => ({ ...prev, [provider]: 'validating' }));

        try {
            let client;
            let isValid = false;
            switch (provider) {
                case 'openai':
                    client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
                    await callAiWithRetry(() => client.models.list());
                    isValid = true;
                    break;
                case 'anthropic':
                    client = new Anthropic({ apiKey: key });
                    await callAiWithRetry(() => client.messages.create({
                        model: AI_MODELS.ANTHROPIC_HAIKU,
                        max_tokens: 1,
                        messages: [{ role: "user", content: "test" }],
                    }));
                    isValid = true;
                    break;
                 case 'openrouter':
                    client = new OpenAI({
                        baseURL: "https://openrouter.ai/api/v1",
                        apiKey: key,
                        dangerouslyAllowBrowser: true,
                        defaultHeaders: {
                            'HTTP-Referer': window.location.href,
                            'X-Title': 'WP Content Optimizer Pro',
                        }
                    });
                    await callAiWithRetry(() => client.chat.completions.create({
                        model: 'google/gemini-2.5-flash',
                        messages: [{ role: "user", content: "test" }],
                        max_tokens: 1
                    }));
                    isValid = true;
                    break;
                case 'groq':
                    client = new OpenAI({
                        baseURL: "https://api.groq.com/openai/v1",
                        apiKey: key,
                        dangerouslyAllowBrowser: true,
                    });
                    await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                        model: AI_MODELS.GROQ_MODELS[1],
                        messages: [{ role: "user", content: "test" }],
                        max_tokens: 1
                    }));
                    isValid = true;
                    break;
                 case 'serper':
                    const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                        method: 'POST',
                        headers: {
                            'X-API-KEY': key,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ q: 'test' })
                    });
                    if (serperResponse.ok) {
                        isValid = true;
                    } else {
                        const errorBody = await serperResponse.json().catch(() => ({ message: `Serper validation failed with status ${serperResponse.status}` }));
                        throw new Error(errorBody.message || `Serper validation failed with status ${serperResponse.status}`);
                    }
                    break;
            }

            if (isValid) {
                setApiKeyStatus(prev => ({ ...prev, [provider]: 'valid' }));
                if (client) {
                     setApiClients(prev => ({ ...prev, [provider]: client as any }));
                }
                setEditingApiKey(null);
            } else {
                 throw new Error("Validation check failed.");
            }
        } catch (error: any) {
            console.error(`${provider} API key validation failed:`, error);
            setApiKeyStatus(prev => ({ ...prev, [provider]: 'invalid' }));
            setApiClients(prev => ({ ...prev, [provider]: null }));
        }
    }, 500), []);
    
     useEffect(() => {
        Object.entries(apiKeys).forEach(([key, value]) => {
            if (value) {
                validateApiKey(key.replace('ApiKey', ''), value as string);
            }
        });
    }, []);

    const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        const provider = name.replace('ApiKey', '');
        setApiKeys(prev => ({ ...prev, [name]: value }));
        validateApiKey(provider, value);
    };
    
    const handleOpenrouterModelsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setOpenrouterModels(e.target.value.split('\n').map(m => m.trim()).filter(Boolean));
    };

    const handleHubSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (hubSortConfig.key === key && hubSortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setHubSortConfig({ key, direction });
    };

    const stopHealthAnalysisRef = useRef(false);
    const handleStopHealthAnalysis = () => {
        stopHealthAnalysisRef.current = true;
    };

    const handleAnalyzeSelectedPages = async () => {
        const pagesToAnalyze = existingPages.filter(p => selectedHubPages.has(p.id));
        if (pagesToAnalyze.length === 0) {
            alert("No pages selected to analyze.");
            return;
        }

        const client = apiClients[selectedModel as keyof typeof apiClients];
        if (!client) {
            alert("API client not available. Please check your API key in Step 1.");
            return;
        }
        
        stopHealthAnalysisRef.current = false;
        setIsAnalyzingHealth(true);
        setHealthAnalysisProgress({ current: 0, total: pagesToAnalyze.length });

        try {
            await processConcurrently(
                pagesToAnalyze,
                async (page) => {
                    const updatePageStatus = (status: SitemapPage['status'], analysis: SitemapPage['analysis'] | null = null, justification: string | null = null) => {
                        setExistingPages(prev => prev.map(p => p.id === page.id ? { ...p, status, analysis, justification: justification ?? p.justification } : p));
                    };

                    updatePageStatus('analyzing');

                    try {
                        let pageHtml = page.crawledContent;
                        if (!pageHtml) {
                            try {
                                const pageResponse = await fetchWithProxies(page.id);
                                pageHtml = await pageResponse.text();
                            } catch (fetchError: any) {
                                throw new Error(`Fetch failed: ${fetchError.message}`);
                            }
                        }

                        const titleMatch = pageHtml.match(/<title>([\s\\S]*?)<\/title>/i);
                        const title = titleMatch ? titleMatch[1] : page.title;

                        let bodyText = pageHtml
                            .replace(/<script[\s\\S]*?<\/script>/gi, '')
                            .replace(/<style[\s\\S]*?<\/style>/gi, '')
                            .replace(/<nav[\s\\S]*?<\/nav>/gi, '')
                            .replace(/<footer[\s\\S]*?<\/footer>/gi, '')
                            .replace(/<header[\s\\S]*?<\/header>/gi, '')
                            .replace(/<aside[\s\\S]*?<\/aside>/gi, '')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        
                        setExistingPages(prev => prev.map(p => p.id === page.id ? { ...p, title, crawledContent: bodyText } : p));

                        if (bodyText.length < 100) {
                            throw new Error("Content is too thin for analysis.");
                        }

                        const contentSnippet = bodyText.substring(0, 12000);
                        const analysisText = await callAI('content_rewrite_analyzer', [title, contentSnippet], 'json', useGoogleSearch);
                        const analysisResult = JSON.parse(extractJson(analysisText));

                        updatePageStatus('analyzed', analysisResult);

                    } catch (error: any) {
                        console.error(`Failed to analyze content for ${page.id}:`, error);
                        updatePageStatus('error', null, error.message.substring(0, 100));
                    }
                },
                3, // Concurrency for analysis
                (completed, total) => {
                    setHealthAnalysisProgress({ current: completed, total: total });
                },
                () => stopHealthAnalysisRef.current
            );
        } catch(error: any) {
            console.error("Content analysis process was interrupted or failed:", error);
        } finally {
            setIsAnalyzingHealth(false);
        }
    };

    const sanitizeTitle = (title: string, slug: string): string => {
        try {
            new URL(title);
            const decodedSlug = decodeURIComponent(slug);
            return decodedSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        } catch (e) {
            return title;
        }
    };

    const handlePlanRewrite = (page: SitemapPage) => {
        const newItem: ContentItem = { 
            id: page.id,
            title: sanitizeTitle(page.title, page.slug), 
            type: 'standard', 
            originalUrl: page.id, 
            status: 'idle', 
            statusText: 'Ready to Rewrite', 
            generatedContent: null, 
            crawledContent: page.crawledContent,
            analysis: page.analysis,
        };
        dispatch({ type: 'SET_ITEMS', payload: [newItem] });
        setActiveView('review');
    };
    
    const handleToggleHubPageSelect = (pageId: string) => {
        setSelectedHubPages(prev => {
            const newSet = new Set(prev);
            if (newSet.has(pageId)) {
                newSet.delete(pageId);
            } else {
                newSet.add(pageId);
            }
            return newSet;
        });
    };

    const handleToggleHubPageSelectAll = () => {
        if (selectedHubPages.size === filteredAndSortedHubPages.length) {
            setSelectedHubPages(new Set());
        } else {
            setSelectedHubPages(new Set(filteredAndSortedHubPages.map(p => p.id)));
        }
    };
    
     const analyzableForRewrite = useMemo(() => {
        return existingPages.filter(p => selectedHubPages.has(p.id) && p.analysis).length;
    }, [selectedHubPages, existingPages]);

    const handleRewriteSelected = () => {
        const selectedPages = existingPages.filter(p => selectedHubPages.has(p.id) && p.analysis);
        if (selectedPages.length === 0) {
            alert("Please select one or more pages that have been successfully analyzed to plan a rewrite. Run the analysis first if you haven't.");
            return;
        }

        const newItems: ContentItem[] = selectedPages.map(page => ({
            id: page.id,
            title: sanitizeTitle(page.title, page.slug),
            type: 'standard',
            originalUrl: page.id,
            status: 'idle',
            statusText: 'Ready to Rewrite',
            generatedContent: null,
            crawledContent: page.crawledContent,
            analysis: page.analysis,
        }));
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setSelectedHubPages(new Set());
        setActiveView('review');
    };
    
    const handleOptimizeLinksSelected = () => {
        const selectedPages = existingPages.filter(p => selectedHubPages.has(p.id));
        if (selectedPages.length === 0) {
             alert("Please select one or more pages to optimize for internal links.");
            return;
        }

        const newItems: ContentItem[] = selectedPages.map(page => ({
            id: page.id,
            title: `Optimize Links: ${sanitizeTitle(page.title, page.slug)}`,
            type: 'link-optimizer',
            originalUrl: page.id,
            status: 'idle',
            statusText: 'Ready to Optimize',
            generatedContent: null,
            crawledContent: page.crawledContent,
        }));
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setSelectedHubPages(new Set());
        setActiveView('review');
    };


    const handleCreatePillarSelected = () => {
        const selectedPages = existingPages.filter(p => selectedHubPages.has(p.id));
        if (selectedPages.length === 0) return;

        const newItems: ContentItem[] = selectedPages.map(page => ({
            id: page.id,
            title: sanitizeTitle(page.title, page.slug),
            type: 'pillar',
            originalUrl: page.id,
            status: 'idle',
            statusText: 'Ready to Generate',
            generatedContent: null,
            crawledContent: page.crawledContent
        }));
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setSelectedHubPages(new Set());
        setActiveView('review');
    };


    const handleCrawlSitemap = async () => {
        if (!sitemapUrl) {
            setCrawlMessage('Please enter a sitemap URL.');
            return;
        }

        setIsCrawling(true);
        setCrawlMessage('');
        setCrawlProgress({ current: 0, total: 0 });
        setExistingPages([]);
        
        workerRef.current?.postMessage({ type: 'CRAWL_SITEMAP', payload: { sitemapUrl } });
    };
    
    const handleGenerateClusterPlan = async () => {
        setIsGenerating(true);
        dispatch({ type: 'SET_ITEMS', payload: [] });
    
        try {
            const responseText = await callAI(
                'cluster_planner',
                [topic],
                'json'
            );
            
            const parsedJson = JSON.parse(extractJson(responseText));
            
            const newItems: Partial<ContentItem>[] = [
                { id: parsedJson.pillarTitle, title: parsedJson.pillarTitle, type: 'pillar' },
                ...parsedJson.clusterTitles.map((title: string) => ({ id: title, title, type: 'cluster' }))
            ];
            dispatch({ type: 'SET_ITEMS', payload: newItems });
            setActiveView('review');
    
        } catch (error: any) {
            console.error("Error generating cluster plan:", error);
            const errorItem: ContentItem = {
                id: 'error-item', title: 'Failed to Generate Plan', type: 'standard', status: 'error',
                statusText: `An error occurred: ${error.message}`, generatedContent: null, crawledContent: null
            };
            dispatch({ type: 'SET_ITEMS', payload: [errorItem] });
        } finally {
            setIsGenerating(false);
        }
    };
    
    const handleGenerateSingleFromKeyword = () => {
        if (!primaryKeyword) return;
        const newItem: Partial<ContentItem> = { id: primaryKeyword, title: primaryKeyword, type: 'standard' };
        dispatch({ type: 'SET_ITEMS', payload: [newItem] });
        setActiveView('review');
    };

    const handleGenerateImages = async () => {
        const geminiClient = apiClients.gemini;
        if (!geminiClient || apiKeyStatus.gemini !== 'valid') {
            setImageGenerationError('Please enter a valid Gemini API key in Step 1 to generate images.');
            return;
        }
        if (!imagePrompt) {
            setImageGenerationError('Please enter a prompt to generate an image.');
            return;
        }

        setIsGeneratingImages(true);
        setGeneratedImages([]);
        setImageGenerationError('');

        try {
            const geminiResponse = await callAiWithRetry(() => geminiClient.models.generateImages({
                model: AI_MODELS.GEMINI_IMAGEN,
                prompt: imagePrompt,
                config: {
                    numberOfImages: numImages,
                    outputMimeType: 'image/jpeg',
                    aspectRatio: aspectRatio as "1:1" | "16:9" | "9:16" | "4:3" | "3:4",
                },
            }));
            const imagesData = geminiResponse.generatedImages.map(img => ({
                src: `data:image/jpeg;base64,${img.image.imageBytes}`,
                prompt: imagePrompt
            }));
            
            setGeneratedImages(imagesData);

        } catch (error: any) {
            console.error("Image generation failed:", error);
            setImageGenerationError(`An error occurred: ${error.message}`);
        } finally {
            setIsGeneratingImages(false);
        }
    };

    const handleDownloadImage = (base64Data: string, prompt: string) => {
        const link = document.createElement('a');
        link.href = base64Data;
        const safePrompt = prompt.substring(0, 30).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        link.download = `generated-image-${safePrompt}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleCopyText = (text: string) => {
        navigator.clipboard.writeText(text).catch(err => {
            console.error('Failed to copy text: ', err);
        });
    };

    const handleToggleSelect = (itemId: string) => {
        setSelectedItems(prev => {
            const newSet = new Set(prev);
            if (newSet.has(itemId)) {
                newSet.delete(itemId);
            } else {
                newSet.add(itemId);
            }
            return newSet;
        });
    };

    const handleToggleSelectAll = () => {
        if (selectedItems.size === filteredAndSortedItems.length) {
            setSelectedItems(new Set());
        } else {
            setSelectedItems(new Set(filteredAndSortedItems.map(item => item.id)));
        }
    };
    
     const filteredAndSortedItems = useMemo(() => {
        let sorted = [...items];
        if (sortConfig.key) {
            sorted.sort((a, b) => {
                const valA = a[sortConfig.key as keyof typeof a];
                const valB = b[sortConfig.key as keyof typeof b];

                if (valA < valB) {
                    return sortConfig.direction === 'asc' ? -1 : 1;
                }
                if (valA > valB) {
                    return sortConfig.direction === 'asc' ? 1 : -1;
                }
                return 0;
            });
        }
        if (filter) {
            return sorted.filter(item => item.title.toLowerCase().includes(filter.toLowerCase()));
        }
        return sorted;
    }, [items, filter, sortConfig]);

    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const handleGenerateSingle = (item: ContentItem) => {
        stopGenerationRef.current.delete(item.id);
        setIsGenerating(true);
        setGenerationProgress({ current: 0, total: 1 });
        generateContent([item]);
    };

    const handleGenerateSelected = () => {
        stopGenerationRef.current.clear();
        const itemsToGenerate = items.filter(item => selectedItems.has(item.id));
        if (itemsToGenerate.length > 0) {
            setIsGenerating(true);
            setGenerationProgress({ current: 0, total: itemsToGenerate.length });
            generateContent(itemsToGenerate);
        }
    };
    
     const handleStopGeneration = (itemId: string | null = null) => {
        if (itemId) {
            stopGenerationRef.current.add(itemId);
             dispatch({
                type: 'UPDATE_STATUS',
                payload: { id: itemId, status: 'idle', statusText: 'Stopped by user' }
            });
        } else {
            // Stop all
            items.forEach(item => {
                if (item.status === 'generating') {
                    stopGenerationRef.current.add(item.id);
                     dispatch({
                        type: 'UPDATE_STATUS',
                        payload: { id: item.id, status: 'idle', statusText: 'Stopped by user' }
                    });
                }
            });
            setIsGenerating(false);
        }
    };

    const generateImageWithFallback = useCallback(async (prompt: string): Promise<string | null> => {
        if (apiClients.openai && apiKeyStatus.openai === 'valid') {
            try {
                console.log("Attempting image generation with OpenAI DALL-E 3...");
                const openaiImgResponse = await callAiWithRetry(() => apiClients.openai!.images.generate({ model: AI_MODELS.OPENAI_DALLE3, prompt, n: 1, size: '1792x1024', response_format: 'b64_json' }));
                const base64Image = openaiImgResponse.data[0].b64_json;
                if (base64Image) {
                    console.log("OpenAI image generation successful.");
                    return `data:image/png;base64,${base64Image}`;
                }
            } catch (error: any) {
                console.warn("OpenAI image generation failed, falling back to Gemini.", error);
            }
        }

        if (apiClients.gemini && apiKeyStatus.gemini === 'valid') {
            try {
                 console.log("Attempting image generation with Google Gemini Imagen...");
                 const geminiImgResponse = await callAiWithRetry(() => apiClients.gemini!.models.generateImages({ model: AI_MODELS.GEMINI_IMAGEN, prompt: prompt, config: { numberOfImages: 1, outputMimeType: 'image/jpeg', aspectRatio: '16:9' } }));
                 const base64Image = geminiImgResponse.generatedImages[0].image.imageBytes;
                 if (base64Image) {
                    console.log("Gemini image generation successful.");
                    return `data:image/jpeg;base64,${base64Image}`;
                 }
            } catch (error: any) {
                 console.error("Gemini image generation also failed.", error);
            }
        }
        
        console.error("All image generation services failed or are unavailable.");
        return null;
    }, [apiClients, apiKeyStatus]);
    
    const callAI = useCallback(async (
        promptKey: keyof typeof PROMPT_TEMPLATES,
        promptArgs: any[],
        responseFormat: 'json' | 'html' = 'json',
        useGrounding: boolean = false
    ): Promise<string> => {
        const client = apiClients[selectedModel as keyof typeof apiClients];
        if (!client) throw new Error(`API Client for '${selectedModel}' not initialized.`);

        const template = PROMPT_TEMPLATES[promptKey];
        const systemInstruction = (promptKey === 'cluster_planner') 
            ? template.systemInstruction.replace('{{GEO_TARGET_INSTRUCTIONS}}', (geoTargeting.enabled && geoTargeting.location) ? `All titles must be geo-targeted for "${geoTargeting.location}".` : '')
            : template.systemInstruction;
            
        // @ts-ignore
        const userPrompt = template.userPrompt(...promptArgs);
        
        let responseText: string | null = '';

        switch (selectedModel) {
            case 'gemini':
                 const geminiConfig: { systemInstruction: string; responseMimeType?: string; tools?: any[] } = { systemInstruction };
                if (responseFormat === 'json') {
                    geminiConfig.responseMimeType = "application/json";
                }
                 if (useGrounding) {
                    geminiConfig.tools = [{googleSearch: {}}];
                    if (geminiConfig.responseMimeType) {
                        delete geminiConfig.responseMimeType;
                    }
                }
                const geminiResponse = await callAiWithRetry(() => (client as GoogleGenAI).models.generateContent({
                    model: AI_MODELS.GEMINI_FLASH,
                    contents: userPrompt,
                    config: geminiConfig,
                }));
                responseText = geminiResponse.text;
                break;
            case 'openai':
                const openaiResponse = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                    model: AI_MODELS.OPENAI_GPT4_TURBO,
                    messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                    ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
                }));
                responseText = openaiResponse.choices[0].message.content;
                break;
            case 'openrouter':
                let lastError: Error | null = null;
                for (const modelName of openrouterModels) {
                    try {
                        console.log(`[OpenRouter] Attempting '${promptKey}' with model: ${modelName}`);
                        const response = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                            model: modelName,
                            messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                             ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
                        }));
                        const content = response.choices[0].message.content;
                        if (!content) throw new Error("Empty response from model.");
                        responseText = content;
                        lastError = null;
                        break;
                    } catch (error: any) {
                        console.error(`OpenRouter model '${modelName}' failed for '${promptKey}'. Trying next...`, error);
                        lastError = error;
                    }
                }
                if (lastError && !responseText) throw lastError;
                break;
            case 'groq':
                 const groqResponse = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                    model: selectedGroqModel,
                    messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                    ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
                }));
                responseText = groqResponse.choices[0].message.content;
                break;
            case 'anthropic':
                const anthropicResponse = await callAiWithRetry(() => (client as Anthropic).messages.create({
                    model: promptKey.includes('section') ? AI_MODELS.ANTHROPIC_HAIKU : AI_MODELS.ANTHROPIC_OPUS,
                    max_tokens: 4096,
                    system: systemInstruction,
                    messages: [{ role: "user", content: userPrompt }],
                }));
                responseText = anthropicResponse.content.map(c => c.text).join("");
                break;
        }

        if (!responseText) {
            throw new Error(`AI returned an empty response for the '${promptKey}' stage.`);
        }

        return responseText;
    }, [apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, useGoogleSearch]);


    const generateContent = useCallback(async (itemsToGenerate: ContentItem[]) => {
        let generatedCount = 0;

        for (const item of itemsToGenerate) {
            if (stopGenerationRef.current.has(item.id)) continue;

            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Initializing...' } });

            let rawResponseForDebugging: any = null;
            let processedContent: GeneratedContent | null = null;
            
            if (item.type === 'link-optimizer') {
                try {
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 1/2: Fetching original content...' } });

                    if (!item.originalUrl) {
                        throw new Error("Original URL is missing for link optimization.");
                    }

                    const pageResponse = await fetchWithProxies(item.originalUrl);
                    const originalHtml = await pageResponse.text();

                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = originalHtml.replace(/<script[^>]*>.*?<\/script>/gi, '');
                    const mainContentElement = tempDiv.querySelector('main, article, .main-content, #main, #content, .post-content, [role="main"]');
                    
                    let contentToOptimize: string | undefined;
                    let isFallback = false;

                    if (mainContentElement) {
                        contentToOptimize = mainContentElement.innerHTML;
                    } else {
                        const bodyElement = tempDiv.querySelector('body');
                        if (bodyElement) {
                            isFallback = true;
                            const clonedBody = bodyElement.cloneNode(true) as HTMLElement;
                            clonedBody.querySelector('header')?.remove();
                            clonedBody.querySelector('footer')?.remove();
                            clonedBody.querySelector('nav')?.remove();
                            contentToOptimize = clonedBody.innerHTML;
                        }
                    }

                    if (!contentToOptimize) {
                        throw new Error("Could not extract main content from the page to optimize.");
                    }
                    
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 2/2: Optimizing Internal Links...' } });

                    const optimizedContentHtml = await callAI('internal_link_optimizer', [contentToOptimize, existingPages], 'html');
                    
                    const finalOptimizedInnerContent = sanitizeHtmlResponse(optimizedContentHtml);
                    
                    let finalContentForPost: string;
                    if (mainContentElement && !isFallback) {
                        mainContentElement.innerHTML = finalOptimizedInnerContent;
                        finalContentForPost = mainContentElement.outerHTML;
                    } else {
                        finalContentForPost = finalOptimizedInnerContent;
                    }

                    const originalTitle = tempDiv.querySelector('title')?.textContent || item.title;
                    const originalMetaDesc = tempDiv.querySelector('meta[name="description"]')?.getAttribute('content') || `Updated content for ${originalTitle}`;

                    const finalContentPayload = normalizeGeneratedContent({
                        title: originalTitle,
                        slug: extractSlugFromUrl(item.originalUrl!),
                        metaDescription: originalMetaDesc,
                        content: finalContentForPost,
                        primaryKeyword: originalTitle,
                        semanticKeywords: [],
                        imageDetails: [],
                        strategy: { targetAudience: '', searchIntent: '', competitorAnalysis: '', contentAngle: '' },
                        jsonLdSchema: {},
                        socialMediaCopy: { twitter: '', linkedIn: '' }
                    }, item.title);

                    finalContentPayload.content = processInternalLinks(finalContentPayload.content, existingPages);
                    finalContentPayload.jsonLdSchema = generateFullSchema(finalContentPayload, wpConfig, siteInfo, [], geoTargeting);

                    dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: finalContentPayload } });

                } catch (error: any) {
                    console.error(`Error optimizing links for "${item.title}":`, error);
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'error', statusText: `Error: ${error.message.substring(0, 100)}...` } });
                } finally {
                    generatedCount++;
                    setGenerationProgress({ current: generatedCount, total: itemsToGenerate.length });
                }
                continue;
            }
             
            try {
                let semanticKeywords: string[] | null = null;
                let serpData: any[] | null = null;
                let peopleAlsoAsk: string[] | null = null;
                let youtubeVideos: any[] | null = null;
                
                const isPillar = item.type === 'pillar';

                if (apiKeys.serperApiKey && apiKeyStatus.serper === 'valid') {
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 1/5: Fetching SERP Data...' } });
                    const cacheKey = `serp-${item.title}`;
                    const cachedSerp = apiCache.get(cacheKey);

                    if (cachedSerp) {
                         serpData = cachedSerp.serpData;
                         youtubeVideos = cachedSerp.youtubeVideos;
                         peopleAlsoAsk = cachedSerp.peopleAlsoAsk;
                    } else {
                        try {
                            const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                                method: 'POST',
                                headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ q: item.title })
                            });
                            if (!serperResponse.ok) throw new Error(`Serper API failed with status ${serperResponse.status}`);
                            const serperJson = await serperResponse.json();
                            serpData = serperJson.organic ? serperJson.organic.slice(0, 10) : [];
                            peopleAlsoAsk = serperJson.peopleAlsoAsk ? serperJson.peopleAlsoAsk.map((p: any) => p.question) : [];
                            
                            const videoCandidates = new Map<string, any>();
                            const videoQueries = [`"${item.title}" tutorial`, `how to ${item.title}`, item.title];

                            for (const query of videoQueries) {
                                if (videoCandidates.size >= 10) break;
                                try {
                                    const videoResponse = await fetchWithProxies("https://google.serper.dev/videos", {
                                        method: 'POST', headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query })
                                    });
                                    if (videoResponse.ok) {
                                        const json = await videoResponse.json();
                                        for (const v of (json.videos || [])) {
                                            const videoId = extractYouTubeID(v.link);
                                            if (videoId && !videoCandidates.has(videoId)) videoCandidates.set(videoId, { ...v, videoId });
                                        }
                                    }
                                } catch (e) { console.warn(`Video search failed for "${query}".`, e); }
                            }
                            youtubeVideos = getUniqueYoutubeVideos(Array.from(videoCandidates.values()), YOUTUBE_EMBED_COUNT);
                            apiCache.set(cacheKey, { serpData, youtubeVideos, peopleAlsoAsk });
                        } catch (serpError) {
                            console.error("Failed to fetch SERP data:", serpError);
                        }
                    }
                }

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 1/5: Analyzing Topic...' } });
                const skCacheKey = `sk-${item.title}`;
                if (apiCache.get(skCacheKey)) {
                    semanticKeywords = apiCache.get(skCacheKey);
                } else {
                    const skResponseText = await callAI('semantic_keyword_generator', [item.title], 'json');
                    const parsedSk = JSON.parse(extractJson(skResponseText));
                    semanticKeywords = parsedSk.semanticKeywords;
                    apiCache.set(skCacheKey, semanticKeywords);
                }

                if (stopGenerationRef.current.has(item.id)) break;

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 2/5: Generating Article Outline...' } });
                const outlineResponseText = await callAI('content_meta_and_outline', [item.title, semanticKeywords, serpData, peopleAlsoAsk, existingPages, item.crawledContent, item.analysis], 'json', useGoogleSearch);
                rawResponseForDebugging = outlineResponseText;
                const metaAndOutline = JSON.parse(extractJson(outlineResponseText));

                metaAndOutline.introduction = sanitizeHtmlResponse(metaAndOutline.introduction);
                metaAndOutline.conclusion = sanitizeHtmlResponse(metaAndOutline.conclusion);

                const fullFaqData: { question: string, answer: string }[] = [];
                let contentParts: string[] = [];
                contentParts.push(metaAndOutline.introduction);
                
                contentParts.push(generateEeatBoxHtml(siteInfo, item.title));
                
                contentParts.push(`<h3>Key Takeaways</h3>\n<ul>\n${metaAndOutline.keyTakeaways.map((t: string) => `<li>${t}</li>`).join('\n')}\n</ul>`);

                const sections = metaAndOutline.outline;
                for (let i = 0; i < sections.length; i++) {
                    if (stopGenerationRef.current.has(item.id)) break;
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 3/5: Writing section ${i + 1} of ${sections.length}...` } });
                    
                    let sectionContent = `<h2>${sections[i]}</h2>`;
                    const sectionHtml = await callAI('write_article_section', [item.title, metaAndOutline.title, sections[i], existingPages], 'html');
                    sectionContent += sanitizeHtmlResponse(sectionHtml);
                    contentParts.push(sectionContent);
                    
                    if (youtubeVideos && youtubeVideos.length > 0) {
                        if (i === 1 && youtubeVideos[0]) {
                            contentParts.push(`<div class="video-container"><iframe width="100%" height="410" src="${youtubeVideos[0].embedUrl}" title="${youtubeVideos[0].title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`);
                        }
                        if (i === Math.floor(sections.length / 2) && youtubeVideos[1]) {
                            contentParts.push(`<div class="video-container"><iframe width="100%" height="410" src="${youtubeVideos[1].embedUrl}" title="${youtubeVideos[1].title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`);
                        }
                    }
                }
                
                contentParts.push(metaAndOutline.conclusion);

                contentParts.push(`<div class="faq-section"><h2>Frequently Asked Questions</h2>`);
                
                for (let i = 0; i < metaAndOutline.faqSection.length; i++) {
                    if (stopGenerationRef.current.has(item.id)) break;
                    const faq = metaAndOutline.faqSection[i];
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 3/5: Answering FAQ ${i + 1} of ${metaAndOutline.faqSection.length}...` } });
                    
                    const answerHtml = await callAI('write_faq_answer', [faq.question], 'html');
                    const cleanAnswer = sanitizeHtmlResponse(answerHtml).replace(/^<p>|<\/p>$/g, '');
                    contentParts.push(`<h3>${faq.question}</h3>\n<p>${cleanAnswer}</p>`);
                    fullFaqData.push({ question: faq.question, answer: cleanAnswer });
                }
                contentParts.push(`</div>`);

                
                if (stopGenerationRef.current.has(item.id)) {
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'idle', statusText: 'Stopped by user' } });
                    break;
                }

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 3/5: Finding Real Sources...` } });
                const contentSummaryForRefs = contentParts.join(' ').replace(/<[^>]+>/g, ' ').substring(0, 2000);
                
                let references: any[] | null = null;
                let rawSearchResultsForFallback: any[] = [];

                if (apiKeys.serperApiKey && apiKeyStatus.serper === 'valid') {
                    const searchQueries = [
                        `academic research and studies on "${metaAndOutline.title}" filetype:pdf`,
                        `"${metaAndOutline.primaryKeyword}" industry report OR analysis 2024 2025`,
                        `in-depth guide "${metaAndOutline.title}" site:.edu OR site:.gov`,
                    ];

                    for (const query of searchQueries) {
                        if (references && references.length > 0) break;
                        try {
                            console.log(`[Reference Search] Attempting query: "${query}"`);
                            const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                                method: 'POST',
                                headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ q: query, num: 15 })
                            });
                            if (!serperResponse.ok) continue;

                            const serperJson = await serperResponse.json();
                            const searchResults = serperJson.organic ? serperJson.organic.map((r: any) => ({
                                title: r.title, link: r.link, snippet: r.snippet
                            })) : [];
                            
                            if (searchResults.length > 0) {
                                rawSearchResultsForFallback.push(...searchResults);
                                const referencesText = await callAI('find_real_references_with_context', [metaAndOutline.title, contentSummaryForRefs, searchResults], 'json');
                                const parsedRefs = JSON.parse(extractJson(referencesText));
                                if (parsedRefs && parsedRefs.length > 0) {
                                    references = parsedRefs;
                                }
                            }
                        } catch (serperError) {
                            console.warn(`[Reference Search] Query failed. Trying next.`, serperError);
                        }
                    }
                }

                if (!references || references.length === 0) {
                    try {
                        console.log("Finding references using Gemini's Google Search grounding as a fallback...");
                        const referencesText = await callAI('find_real_references', [metaAndOutline.title, contentSummaryForRefs], 'json', true);
                        references = JSON.parse(extractJson(referencesText));
                    } catch (groundingError) {
                         console.error("Gemini's Google Search grounding also failed.", groundingError);
                    }
                }
                
                if (references && Array.isArray(references) && references.length > 0) {
                    let referencesHtml = '<h2>References</h2>\n<ol>\n';
                    for (const ref of references) {
                        if (ref.title && ref.url && ref.source && ref.year) {
                            const safeTitle = ref.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            const safeSource = ref.source.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            if (String(ref.url).startsWith('http')) {
                                referencesHtml += `<li><a href="${ref.url}" target="_blank" rel="noopener noreferrer">${safeTitle}</a> (${safeSource}, ${ref.year})</li>\n`;
                            }
                        }
                    }
                    referencesHtml += '</ol>';
                    contentParts.push(referencesHtml);
                } else {
                    console.warn(`[Reference Generation] Automated extraction failed. Using SOTA fallback.`);
                    const uniqueLinks = new Map();
                    rawSearchResultsForFallback.forEach(r => { if (r.link && !uniqueLinks.has(r.link)) uniqueLinks.set(r.link, r); });
                    const filteredResults = Array.from(uniqueLinks.values()).filter(r => 
                        !['pinterest.com', 'youtube.com', 'facebook.com', 'twitter.com', 'forum', '.quora.com'].some(domain => r.link.includes(domain))
                    ).slice(0, 10);
                    
                    if (filteredResults.length > 0) {
                        let suggestedReadingHtml = `
                        <div class="manual-action-required-box warning-box">
                            <h3><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.2em; height: 1.2em; margin-right: 0.5em;"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Suggested Reading &amp; Further Research</h3>
                            <p>The following resources were automatically identified as highly relevant. Please review them for suitability as formal references and cite them where appropriate.</p>
                            <ul>${filteredResults.map(r => `<li><a href="${r.link}" target="_blank" rel="noopener noreferrer">${r.title}</a></li>`).join('\n')}</ul>
                        </div>`;
                        contentParts.push(suggestedReadingHtml);
                    } else {
                        const originalWarningHtml = `
                        <div class="manual-action-required-box error-box">
                            <h3><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.2em; height: 1.2em; margin-right: 0.5em;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> Action Required: Add References</h3>
                            <p>Our automated reference finder could not locate credible sources for this topic. Please manually research and add a list of 8-12 authoritative references in this section.</p>
                        </div>`;
                        contentParts.push(originalWarningHtml);
                    }
                }

                let finalContent = contentParts.join('\n\n');
                
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 4/5: Generating Images...' } });
                const updatedImageDetails = [...metaAndOutline.imageDetails];
                for (let i = 0; i < updatedImageDetails.length; i++) {
                    if (stopGenerationRef.current.has(item.id)) break;
                    const imageDetail = updatedImageDetails[i];
                    try {
                        const generatedImageSrc = await generateImageWithFallback(imageDetail.prompt);
                        if (generatedImageSrc) {
                            imageDetail.generatedImageSrc = generatedImageSrc;
                            const imageHtml = `<figure class="wp-block-image size-large"><img src="${generatedImageSrc}" alt="${imageDetail.altText}" title="${imageDetail.title}"/><figcaption>${imageDetail.altText}</figcaption></figure>`;
                            finalContent = finalContent.replace(imageDetail.placeholder, imageHtml);
                        } else {
                             finalContent = finalContent.replace(imageDetail.placeholder, '');
                        }
                    } catch (imgError) {
                        console.error(`Failed to generate image for prompt: "${imageDetail.prompt}"`, imgError);
                        finalContent = finalContent.replace(imageDetail.placeholder, '');
                    }
                }
                finalContent = finalContent.replace(/\[IMAGE_\d_PLACEHOLDER\]/g, '');

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 5/5: Finalizing...' } });
                
                finalContent = sanitizeBrokenPlaceholders(finalContent);
                finalContent = validateAndRepairInternalLinks(finalContent, existingPages);
                finalContent = enforceInternalLinkQuota(finalContent, existingPages, metaAndOutline.primaryKeyword, MIN_INTERNAL_LINKS);
                finalContent = processInternalLinks(finalContent, existingPages);
                finalContent = enforceUniqueVideoEmbeds(finalContent, youtubeVideos || []);

                const minWords = isPillar ? TARGET_MIN_WORDS_PILLAR : TARGET_MIN_WORDS;
                const maxWords = isPillar ? TARGET_MAX_WORDS_PILLAR : TARGET_MAX_WORDS;
                enforceWordCount(finalContent, minWords, maxWords);
                checkHumanWritingScore(finalContent);
                
                processedContent = normalizeGeneratedContent({
                    ...metaAndOutline,
                    content: finalContent,
                    imageDetails: updatedImageDetails,
                    serpData: serpData
                }, item.title);
                
                processedContent.jsonLdSchema = generateFullSchema(processedContent, wpConfig, siteInfo, fullFaqData, geoTargeting);

                dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: processedContent } });
            
            } catch (error: any) {
                console.error(`Error generating content for "${item.title}":`, error);
                
                if (error instanceof ContentTooShortError) {
                    const salvagedContent = normalizeGeneratedContent({
                        title: item.title,
                        content: error.content,
                    }, item.title);

                    dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: salvagedContent } });
                    
                    dispatch({
                        type: 'UPDATE_STATUS',
                        payload: {
                            id: item.id,
                            status: 'error',
                            statusText: `Content too short (${error.wordCount} words). Review manually.`
                        }
                    });
                } else {
                    dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'error', statusText: `Error: ${error.message.substring(0, 100)}...` } });
                }
            } finally {
                generatedCount++;
                setGenerationProgress({ current: generatedCount, total: itemsToGenerate.length });
            }
        }

        setIsGenerating(false);

    }, [apiClients, apiKeys, apiKeyStatus, callAI, existingPages, generateImageWithFallback, geoTargeting, openrouterModels, selectedGroqModel, selectedModel, siteInfo, useGoogleSearch, wpConfig]);
    
    const publishItemToWordPress = async (
        itemToPublish: ContentItem,
        currentWpPassword: string,
        status: 'publish' | 'draft'
    ): Promise<{ success: boolean; message: React.ReactNode; link?: string }> => {
        const { generatedContent } = itemToPublish;
        if (!generatedContent) {
            return { success: false, message: 'No content to publish.' };
        }

        let contentWithWpImages = generatedContent.content;
        let featuredImageId: number | null = null;
        const base64ImageRegex = /<img[^>]+src="data:image\/(jpeg|png|webp);base64,([^"]+)"[^>]*>/g;
        const imagesToUpload = [...contentWithWpImages.matchAll(base64ImageRegex)];

        for (const [index, imageMatch] of imagesToUpload.entries()) {
            const fullImgTag = imageMatch[0];
            const mimeType = `image/${imageMatch[1]}`;
            const base64Data = imageMatch[2];
            const altText = fullImgTag.match(/alt="([^"]*)"/)?.[1] || generatedContent.title;
            const imgTitle = fullImgTag.match(/title="([^"]*)"/)?.[1] || generatedContent.slug;

            try {
                const res = await fetch(`data:${mimeType};base64,${base64Data}`);
                const blob = await res.blob();
                const uploadUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/media`;
                
                const headers = new Headers({
                    'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}`,
                    'Content-Disposition': `attachment; filename="${imgTitle}-${index}.${imageMatch[1]}"`,
                    'Content-Type': mimeType,
                });

                const uploadResponse = await fetchWordPressWithRetry(uploadUrl, { method: 'POST', headers, body: blob });
                
                if (!uploadResponse.ok) {
                    const errorData = await uploadResponse.json().catch(() => ({ message: 'Unknown upload error' }));
                    throw new Error(`Media upload failed: ${errorData.message}`);
                }
                
                const mediaData = await uploadResponse.json();
                const newImageUrl = mediaData.source_url;
                const newImgTag = fullImgTag.replace(/src="[^"]+"/, `src="${newImageUrl}" class="wp-image-${mediaData.id}"`);
                contentWithWpImages = contentWithWpImages.replace(fullImgTag, newImgTag);

                if (index === 0) {
                    featuredImageId = mediaData.id;
                }
            } catch (error: any) {
                console.error('Image upload failed:', error);
                return { success: false, message: `Image upload failed: ${error.message}` };
            }
        }

        const postData: any = {
            title: generatedContent.title,
            content: contentWithWpImages + generateSchemaMarkup(generatedContent.jsonLdSchema),
            status: status,
            slug: generatedContent.slug,
            meta: {
                _yoast_wpseo_title: generatedContent.title,
                _yoast_wpseo_metadesc: generatedContent.metaDescription,
                rank_math_title: generatedContent.title,
                rank_math_description: generatedContent.metaDescription,
            }
        };
        if (featuredImageId) {
            postData.featured_media = featuredImageId;
        }

        try {
            let apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;
            let method = 'POST';

            if (itemToPublish.originalUrl) {
                const slug = extractSlugFromUrl(itemToPublish.originalUrl);
                // SOTA FIX: Search for posts in ANY status (publish, draft, pending, etc.) to ensure updates always work.
                const lookupUrl = `${apiUrl}?slug=${slug}&_fields=id&status=publish,future,draft,pending,private`;
                
                const headers = new Headers({ 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}` });
                const lookupResponse = await fetchWordPressWithRetry(lookupUrl, { headers });
                
                if (!lookupResponse.ok) throw new Error('Failed to look up original post for update.');
                
                const posts = await lookupResponse.json();
                if (posts.length > 0) {
                    const postId = posts[0].id;
                    apiUrl = `${apiUrl}/${postId}`;
                } else {
                     return { success: false, message: `Could not find original post with slug "${slug}" to update.` };
                }
            }

            const postResponse = await fetchWordPressWithRetry(apiUrl, {
                method: 'POST',
                headers: new Headers({
                    'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}`,
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify(postData)
            });
            
            const responseData = await postResponse.json();
            if (!postResponse.ok) {
                throw new Error(responseData.message || `API returned status ${postResponse.status}`);
            }
            
            const actionText = itemToPublish.originalUrl ? 'updated' : 'published';
            return {
                success: true,
                message: (<span>Successfully {actionText}! <a href={responseData.link} target="_blank" rel="noopener noreferrer">View Post</a></span>),
                link: responseData.link,
            };
        } catch (error: any) {
            return { success: false, message: `Error: ${error.message}` };
        }
    };

    return (
        <div className="app-container">
            <header className="app-header">
                <div className="app-header-content">
                    <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">
                        <img src="https://affiliatemarketingforsuccess.com/wp-content/uploads/2023/03/cropped-Affiliate-Marketing-for-Success-Logo-Edited.png?lm=6666FEE0" alt="WP Content Optimizer Pro Logo" className="header-logo" />
                    </a>
                    <div className="header-title-group">
                        <h1>WP Content <span>Optimizer Pro</span></h1>
                        <p className="header-tagline">By <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">Alexios Papaioannou</a></p>
                    </div>
                </div>
            </header>
            <div className="main-layout">
                <aside className="sidebar">
                    <SidebarNav activeView={activeView} onNavClick={setActiveView} />
                </aside>
                <main className="main-content">
                    {activeView === 'setup' && (
                        <div className="setup-view">
                            <div className="page-header">
                                <h2 className="gradient-headline">1. Setup & Configuration</h2>
                                <p>Connect your AI services and WordPress site to get started. All keys are stored securely in your browser's local storage.</p>
                            </div>
                            <div className="setup-grid">
                                <div className="setup-card">
                                    <h3>API Keys</h3>
                                    <div className="form-group">
                                        <label>Google Gemini API Key</label>
                                        <div className="api-key-group">
                                            <input type="text" readOnly value="Loaded from Environment" disabled />
                                             <div className="key-status-icon">
                                                {apiKeyStatus.gemini === 'validating' && <div className="key-status-spinner"></div>}
                                                {apiKeyStatus.gemini === 'valid' && <span className="success"><CheckIcon /></span>}
                                                {apiKeyStatus.gemini === 'invalid' && <span className="error"><XIcon /></span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="form-group">
                                        <label>OpenAI API Key</label>
                                        <ApiKeyInput provider="openai" value={apiKeys.openaiApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.openai} isEditing={editingApiKey === 'openai'} onEdit={() => setEditingApiKey('openai')} />
                                    </div>
                                    <div className="form-group">
                                        <label>Anthropic API Key</label>
                                        <ApiKeyInput provider="anthropic" value={apiKeys.anthropicApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.anthropic} isEditing={editingApiKey === 'anthropic'} onEdit={() => setEditingApiKey('anthropic')} />
                                    </div>
                                     <div className="form-group">
                                        <label>OpenRouter API Key</label>
                                        <ApiKeyInput provider="openrouter" value={apiKeys.openrouterApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.openrouter} isEditing={editingApiKey === 'openrouter'} onEdit={() => setEditingApiKey('openrouter')} />
                                    </div>
                                     <div className="form-group">
                                        <label>Groq API Key</label>
                                        <ApiKeyInput provider="groq" value={apiKeys.groqApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.groq} isEditing={editingApiKey === 'groq'} onEdit={() => setEditingApiKey('groq')} />
                                    </div>
                                    <div className="form-group">
                                        <label>Serper API Key</label>
                                        <ApiKeyInput provider="serper" value={apiKeys.serperApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.serper} isEditing={editingApiKey === 'serper'} onEdit={() => setEditingApiKey('serper')} />
                                    </div>
                                </div>
                                <div className="setup-card">
                                    <h3>AI Model Configuration</h3>
                                    <div className="form-group">
                                        <label htmlFor="model-select">Primary Generation Model</label>
                                        <select id="model-select" value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                                            <option value="gemini">Google Gemini 2.5 Flash</option>
                                            <option value="openai">OpenAI GPT-4o</option>
                                            <option value="anthropic">Anthropic Claude 3</option>
                                            <option value="openrouter">OpenRouter (Auto-Fallback)</option>
                                            <option value="groq">Groq (High-Speed)</option>
                                        </select>
                                    </div>
                                    {selectedModel === 'openrouter' && (
                                        <div className="form-group">
                                            <label>OpenRouter Model Fallback Chain (one per line)</label>
                                            <textarea value={openrouterModels.join('\n')} onChange={handleOpenrouterModelsChange} rows={5}></textarea>
                                        </div>
                                    )}
                                     {selectedModel === 'groq' && (
                                        <div className="form-group">
                                            <label htmlFor="groq-model-select">Groq Model</label>
                                            <select id="groq-model-select" value={selectedGroqModel} onChange={e => setSelectedGroqModel(e.target.value)}>
                                                {AI_MODELS.GROQ_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                        </div>
                                    )}
                                     <div className="form-group checkbox-group">
                                        <input type="checkbox" id="useGoogleSearch" checked={useGoogleSearch} onChange={e => setUseGoogleSearch(e.target.checked)} />
                                        <label htmlFor="useGoogleSearch">Enable Google Search Grounding</label>
                                    </div>
                                    <p className="help-text">Grounding provides the AI with real-time search results for more accurate, up-to-date content. Recommended for time-sensitive topics.</p>
                                </div>

                                <div className="setup-card full-width">
                                    <h3>WordPress & Site Information</h3>
                                    <div className="schema-settings-grid">
                                        <div className="form-group">
                                            <label htmlFor="wpUrl">WordPress Site URL</label>
                                            <input type="url" id="wpUrl" value={wpConfig.url} onChange={e => setWpConfig(p => ({...p, url: e.target.value}))} placeholder="https://example.com" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="wpUsername">WordPress Username</label>
                                            <input type="text" id="wpUsername" value={wpConfig.username} onChange={e => setWpConfig(p => ({...p, username: e.target.value}))} placeholder="your_username" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="wpPassword">WordPress Application Password</label>
                                            <input type="password" id="wpPassword" value={wpPassword} onChange={e => setWpPassword(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="orgName">Organization Name</label>
                                            <input type="text" id="orgName" value={siteInfo.orgName} onChange={e => setSiteInfo(p => ({...p, orgName: e.target.value}))} placeholder="My Awesome Blog" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="logoUrl">Logo URL</label>
                                            <input type="url" id="logoUrl" value={siteInfo.logoUrl} onChange={e => setSiteInfo(p => ({...p, logoUrl: e.target.value}))} placeholder="https://example.com/logo.png" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="authorName">Author Name</label>
                                            <input type="text" id="authorName" value={siteInfo.authorName} onChange={e => setSiteInfo(p => ({...p, authorName: e.target.value}))} placeholder="John Doe" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="authorUrl">Author Page URL</label>
                                            <input type="url" id="authorUrl" value={siteInfo.authorUrl} onChange={e => setSiteInfo(p => ({...p, authorUrl: e.target.value}))} placeholder="https://example.com/about-me" />
                                        </div>
                                    </div>
                                </div>
                                <div className="setup-card full-width">
                                    <h3>Advanced Geo-Targeting</h3>
                                    <div className="form-group checkbox-group">
                                        <input type="checkbox" id="geo-enabled" checked={geoTargeting.enabled} onChange={(e) => setGeoTargeting(p => ({...p, enabled: e.target.checked}))} />
                                        <label htmlFor="geo-enabled">Enable Geo-Targeting for Content</label>
                                    </div>
                                    {geoTargeting.enabled && (
                                        <div className="schema-settings-grid">
                                            <input type="text" value={geoTargeting.location} onChange={e => setGeoTargeting(p => ({...p, location: e.target.value}))} placeholder="City (e.g., Austin)" />
                                            <input type="text" value={geoTargeting.region} onChange={e => setGeoTargeting(p => ({...p, region: e.target.value}))} placeholder="State/Region (e.g., TX)" />
                                            <input type="text" value={geoTargeting.country} onChange={e => setGeoTargeting(p => ({...p, country: e.target.value}))} placeholder="Country Code (e.g., US)" />
                                            <input type="text" value={geoTargeting.postalCode} onChange={e => setGeoTargeting(p => ({...p, postalCode: e.target.value}))} placeholder="Postal Code (e.g., 78701)" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    {activeView === 'strategy' && (
                        <div className="content-strategy-view">
                             <div className="page-header">
                                <h2 className="gradient-headline">2. Content Strategy & Planning</h2>
                                <p>Choose your content creation method. Plan a full topic cluster, generate a single article from a keyword, or use the Content Hub to analyze and rewrite existing posts.</p>
                            </div>
                            <div className="tabs-container">
                                <div className="tabs" role="tablist">
                                    <button className={`tab-btn ${contentMode === 'bulk' ? 'active' : ''}`} onClick={() => setContentMode('bulk')} role="tab">Bulk Content Planner</button>
                                    <button className={`tab-btn ${contentMode === 'single' ? 'active' : ''}`} onClick={() => setContentMode('single')} role="tab">Single Article</button>
                                    <button className={`tab-btn ${contentMode === 'hub' ? 'active' : ''}`} onClick={() => setContentMode('hub')} role="tab">Content Hub</button>
                                    <button className={`tab-btn ${contentMode === 'imageGenerator' ? 'active' : ''}`} onClick={() => setContentMode('imageGenerator')} role="tab">Image Generator</button>
                                </div>
                            </div>
                            {contentMode === 'bulk' && (
                                <div className="tab-panel">
                                    <h3>Bulk Content Planner</h3>
                                    <p className="help-text">Enter a broad topic (e.g., "digital marketing") to generate a complete pillar page and cluster content plan, optimized for topical authority.</p>
                                    <div className="form-group">
                                        <label htmlFor="topic">Broad Topic</label>
                                        <input type="text" id="topic" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g., Landscape Photography" />
                                    </div>
                                    <button className="btn" onClick={handleGenerateClusterPlan} disabled={isGenerating || !topic}>
                                        {isGenerating ? 'Generating...' : 'Generate Content Plan'}
                                    </button>
                                </div>
                            )}
                             {contentMode === 'single' && (
                                <div className="tab-panel">
                                    <h3>Single Article from Keyword</h3>
                                    <p className="help-text">Enter a specific primary keyword to generate one, highly-optimized article.</p>
                                     <div className="form-group">
                                        <label htmlFor="primaryKeyword">Primary Keyword</label>
                                        <input type="text" id="primaryKeyword" value={primaryKeyword} onChange={e => setPrimaryKeyword(e.target.value)} placeholder="e.g., best camera for landscape photography" />
                                    </div>
                                    <button className="btn" onClick={handleGenerateSingleFromKeyword} disabled={!primaryKeyword}>Go to Review &rarr;</button>
                                </div>
                            )}
                            {contentMode === 'hub' && (
                                 <div className="tab-panel">
                                    <h3>Content Hub & Rewrite Assistant</h3>
                                    <p className="help-text">Enter your sitemap URL to crawl your existing content. Analyze posts for SEO health and generate strategic rewrite plans.</p>
                                    <div className="sitemap-crawler-form">
                                        <div className="form-group">
                                             <label htmlFor="sitemapUrl">Sitemap URL</label>
                                             <input type="url" id="sitemapUrl" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} placeholder="https://example.com/sitemap_index.xml" />
                                        </div>
                                        <button className="btn" onClick={handleCrawlSitemap} disabled={isCrawling}>
                                            {isCrawling ? 'Crawling...' : 'Crawl Sitemap'}
                                        </button>
                                    </div>
                                    {crawlMessage && <div className="crawl-status">{crawlMessage}</div>}
                                    {existingPages.length > 0 && (
                                        <div className="content-hub-table-container">
                                            <div className="table-controls">
                                                <input type="search" placeholder="Search pages..." className="filter-input" value={hubSearchFilter} onChange={e => setHubSearchFilter(e.target.value)} />
                                                 <select value={hubStatusFilter} onChange={e => setHubStatusFilter(e.target.value)}>
                                                    <option value="All">All Statuses</option>
                                                    <option value="Critical">Critical</option>
                                                    <option value="High">High</option>
                                                    <option value="Medium">Medium</option>
                                                    <option value="Healthy">Healthy</option>
                                                </select>
                                                <div className="table-actions">
                                                    <button className="btn btn-secondary" onClick={handleAnalyzeSelectedPages} disabled={isAnalyzingHealth || selectedHubPages.size === 0}>
                                                        {isAnalyzingHealth ? `Analyzing... (${healthAnalysisProgress.current}/${healthAnalysisProgress.total})` : `Analyze Selected (${selectedHubPages.size})`}
                                                    </button>
                                                    <button className="btn" onClick={handleRewriteSelected} disabled={analyzableForRewrite === 0}>Rewrite Selected ({analyzableForRewrite})</button>
                                                </div>
                                            </div>
                                            <table className="content-hub-table">
                                                <thead>
                                                    <tr>
                                                        <th><input type="checkbox" onChange={handleToggleHubPageSelectAll} checked={selectedHubPages.size > 0 && selectedHubPages.size === filteredAndSortedHubPages.length} /></th>
                                                        <th onClick={() => handleHubSort('title')}>Title & Slug</th>
                                                        <th onClick={() => handleHubSort('daysOld')}>Age</th>
                                                        <th onClick={() => handleHubSort('updatePriority')}>Status</th>
                                                         <th>Analysis & Actions</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                {isCrawling ? <SkeletonLoader rows={10} columns={5} /> : filteredAndSortedHubPages.map(page => (
                                                        <tr key={page.id}>
                                                            <td><input type="checkbox" checked={selectedHubPages.has(page.id)} onChange={() => handleToggleHubPageSelect(page.id)} /></td>
                                                            <td className="hub-title-cell">
                                                                <a href={page.id} target="_blank" rel="noopener noreferrer">{sanitizeTitle(page.title, page.slug)}</a>
                                                                <div className="slug">{page.id}</div>
                                                            </td>
                                                            <td>{page.daysOld !== null ? `${page.daysOld} days` : 'N/A'}</td>
                                                            <td><div className="status-cell">{page.updatePriority ? <span className={`priority-${page.updatePriority}`}>{page.updatePriority}</span> : 'Not Analyzed'}</div></td>
                                                            <td>
                                                                {page.status === 'analyzing' && <div className="status-cell"><div className="status-indicator analyzing"></div>Analyzing...</div>}
                                                                {page.status === 'error' && <div className="status-cell"><div className="status-indicator error"></div>Error</div>}
                                                                {page.status === 'analyzed' && page.analysis && (
                                                                    <button className="btn btn-small" onClick={() => setViewingAnalysis(page)}>View Rewrite Plan</button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                             {contentMode === 'imageGenerator' && (
                                <div className="tab-panel">
                                    <h3>SOTA Image Generator</h3>
                                    <p className="help-text">Generate high-quality images for your content using DALL-E 3 or Gemini Imagen. Describe the image you want in detail.</p>
                                    <div className="form-group">
                                        <label htmlFor="imagePrompt">Image Prompt</label>
                                        <textarea id="imagePrompt" value={imagePrompt} onChange={e => setImagePrompt(e.target.value)} rows={4} placeholder="e.g., A photorealistic image of a golden retriever puppy playing in a field of flowers, cinematic lighting, 16:9 aspect ratio." />
                                    </div>
                                    <div className="form-group-row">
                                        <div className="form-group">
                                            <label htmlFor="numImages">Number of Images</label>
                                            <select id="numImages" value={numImages} onChange={e => setNumImages(Number(e.target.value))}>
                                                {[1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
                                            </select>
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="aspectRatio">Aspect Ratio</label>
                                            <select id="aspectRatio" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                                <option value="1:1">1:1 (Square)</option>
                                                <option value="16:9">16:9 (Widescreen)</option>
                                                <option value="9:16">9:16 (Vertical)</option>
                                                <option value="4:3">4:3 (Landscape)</option>
                                                <option value="3:4">3:4 (Portrait)</option>
                                            </select>
                                        </div>
                                    </div>
                                    <button className="btn" onClick={handleGenerateImages} disabled={isGeneratingImages || !imagePrompt}>
                                        {isGeneratingImages ? <><div className="spinner"></div> Generating...</> : 'Generate Images'}
                                    </button>
                                    {imageGenerationError && <p className="error" style={{marginTop: '1rem'}}>{imageGenerationError}</p>}
                                    {generatedImages.length > 0 && (
                                        <div className="image-assets-grid" style={{marginTop: '2rem'}}>
                                            {generatedImages.map((image, index) => (
                                                <div key={index} className="image-asset-card">
                                                    <img src={image.src} alt={image.prompt} loading="lazy" />
                                                    <div className="image-asset-details">
                                                        <button className="btn btn-small" onClick={() => handleDownloadImage(image.src, image.prompt)}>Download</button>
                                                        <button className="btn btn-small btn-secondary" onClick={() => handleCopyText(image.prompt)}>Copy Prompt</button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {activeView === 'review' && (
                        <div className="review-export-view">
                            <div className="page-header">
                                <h2 className="gradient-headline">3. Review, Edit & Export</h2>
                                <p>Review the generated content, make any final edits, and publish directly to your WordPress site or copy the HTML.</p>
                            </div>
                            <div className="review-table-container">
                                <div className="table-controls">
                                    <input type="search" className="filter-input" placeholder="Filter by title..." value={filter} onChange={e => setFilter(e.target.value)} />
                                    <div className="table-actions">
                                        <button className="btn btn-secondary" onClick={handleGenerateSelected} disabled={isGenerating || selectedItems.size === 0}>
                                            {isGenerating ? 'Generating...' : `Generate Selected (${selectedItems.size})`}
                                        </button>
                                        <button className="btn" onClick={() => setIsBulkPublishModalOpen(true)} disabled={items.filter(i => i.status === 'done' && selectedItems.has(i.id)).length === 0}>
                                            Bulk Publish Selected
                                        </button>
                                    </div>
                                </div>
                                <table className="review-table">
                                     <thead>
                                        <tr>
                                            <th><input type="checkbox" onChange={handleToggleSelectAll} checked={selectedItems.size > 0 && selectedItems.size === filteredAndSortedItems.length} /></th>
                                            <th onClick={() => handleSort('title')}>Title</th>
                                            <th onClick={() => handleSort('type')}>Type</th>
                                            <th onClick={() => handleSort('status')}>Status</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredAndSortedItems.map(item => (
                                            <tr key={item.id}>
                                                <td><input type="checkbox" checked={selectedItems.has(item.id)} onChange={() => handleToggleSelect(item.id)} /></td>
                                                <td>{item.title}</td>
                                                <td><span className={`badge ${item.type}`}>{item.type.replace('-', ' ')}</span></td>
                                                <td>
                                                    <div className="status-cell">
                                                        <div className={`status-indicator ${item.status}`}></div>
                                                        <span>{item.statusText}</span>
                                                    </div>
                                                </td>
                                                <td>
                                                    <div className="modal-actions">
                                                        {item.status === 'done' && <button className="btn btn-small" onClick={() => setSelectedItemForReview(item)}>Review & Edit</button>}
                                                        {item.status === 'error' && item.generatedContent && <button className="btn btn-small" onClick={() => setSelectedItemForReview(item)}>Review (Partial)</button>}
                                                        {(item.status === 'idle' || item.status === 'error') && <button className="btn btn-small btn-secondary" onClick={() => handleGenerateSingle(item)}>Generate</button>}
                                                        {item.status === 'generating' && <button className="btn btn-small btn-secondary" onClick={() => handleStopGeneration(item.id)}>Stop</button>}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {isGenerating && (
                                     <div className="progress-bar-container" style={{marginTop: '1.5rem'}}>
                                        <div className="progress-bar-fill good" style={{width: `${(generationProgress.current / generationProgress.total) * 100}%`}}></div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </main>
            </div>
            <AppFooter />
            {selectedItemForReview && (
                <ReviewModal 
                    item={selectedItemForReview}
                    onClose={() => setSelectedItemForReview(null)}
                    onSaveChanges={(id, seo, content) => {
                        const updatedContent = { ...selectedItemForReview.generatedContent!, ...seo, content };
                        dispatch({ type: 'SET_CONTENT', payload: { id, content: updatedContent } });
                        setSelectedItemForReview(p => p ? {...p, generatedContent: updatedContent} : null);
                    }}
                    wpConfig={wpConfig}
                    wpPassword={wpPassword}
                    onPublishSuccess={(originalUrl) => {
                        setExistingPages(prev => prev.map(p => p.id === originalUrl ? {...p, publishedState: 'updated'} : p));
                    }}
                    publishItem={publishItemToWordPress}
                    callAI={callAI}
                    geoTargeting={geoTargeting}
                />
            )}
             {isBulkPublishModalOpen && (
                <BulkPublishModal
                    items={items.filter(i => i.status === 'done' && selectedItems.has(i.id))}
                    onClose={() => setIsBulkPublishModalOpen(false)}
                    wpPassword={wpPassword}
                    publishItem={publishItemToWordPress}
                    onPublishSuccess={(originalUrl) => {
                         setExistingPages(prev => prev.map(p => p.id === originalUrl ? {...p, publishedState: 'updated'} : p));
                    }}
                />
            )}
            {viewingAnalysis && (
                 <AnalysisModal
                    page={viewingAnalysis}
                    onClose={() => setViewingAnalysis(null)}
                    onPlanRewrite={handlePlanRewrite}
                />
            )}
        </div>
    );
};

// Application's entry point.
const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}
