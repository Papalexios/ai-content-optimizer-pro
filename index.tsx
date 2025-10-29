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
    if (sentences.length > 10) { // Need enough sentences for a meaningful analysis
        const sentenceLengths = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
        const avgLength = sentenceLengths.reduce((sum, len) => sum + len, 0) / sentenceLengths.length;
        
        if (avgLength > 25) {
            aiScore += 15;
            console.warn(`⚠️  Average sentence too long (${avgLength.toFixed(1)} words)`);
        }

        // --- NEW: Check for sentence length variability ---
        const variance = sentenceLengths.map(len => Math.pow(len - avgLength, 2)).reduce((sum, sq) => sum + sq, 0) / sentenceLengths.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev < 2.5) { // Low standard deviation indicates uniform, robotic sentence lengths
            aiScore += 15;
            console.warn(`⚠️  Low sentence length variety (Std Dev: ${stdDev.toFixed(1)}). Sounds robotic.`);
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

const validateYouTubeVideo = async (videoId: string): Promise<boolean> => {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    return response.ok;
  } catch {
    return false;
  }
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
 * A highly professional and resilient fetch function for AI APIs that includes
 * intelligent exponential backoff and strictly adheres to `Retry-After` headers.
 * It fails fast on non-retriable errors and robustly parses error responses from multiple SDKs.
 * This is the SOTA standard for handling rate limits (429) and transient server issues (5xx).
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
            
            // SOTA FIX: More robustly check for status code from different error structures.
            const statusMatch = errorMessage.match(/status code (\d{3})/);
            const statusCode = error.status ?? error.response?.status ?? (statusMatch ? parseInt(statusMatch[1], 10) : null);

            const isNonRetriableClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
            const isContextLengthError = errorMessage.includes('context length') || errorMessage.includes('token limit');
            const isInvalidApiKeyError = errorMessage.includes('api key not valid') || statusCode === 401;

            if (isNonRetriableClientError || isContextLengthError || isInvalidApiKeyError) {
                 console.error(`Encountered a non-retriable error (Status: ${statusCode}, Message: ${error.message}). Failing immediately.`);
                 throw error; // Fail fast.
            }

            if (attempt === maxRetries - 1) {
                console.error(`AI call failed on final attempt (${maxRetries}).`);
                throw error;
            }
            
            let delay: number;
            
            if (statusCode === 429) {
                // SOTA FIX: Robustly check for the Retry-After header in multiple possible locations.
                const headers = error.headers ?? error.response?.headers;
                const retryAfterHeader = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
                
                if (retryAfterHeader) {
                    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(retryAfterSeconds)) {
                        // Value is in seconds.
                        delay = retryAfterSeconds * 1000 + 500; // Add a 500ms buffer.
                        console.log(`Rate limit hit. API requested a delay of ${retryAfterSeconds}s. Waiting...`);
                    } else {
                        // Value might be an HTTP-date.
                        const retryDate = new Date(retryAfterHeader);
                        if (!isNaN(retryDate.getTime())) {
                            delay = retryDate.getTime() - Date.now() + 500; // Add buffer.
                            console.log(`Rate limit hit. API requested waiting until ${retryDate.toISOString()}. Waiting...`);
                        } else {
                             // Fallback if the date format is unexpected.
                             delay = initialDelay * Math.pow(2, attempt) + (Math.random() * 1000);
                             console.log(`Rate limit hit. Could not parse 'Retry-After' header ('${retryAfterHeader}'). Using exponential backoff.`);
                        }
                    }
                } else {
                    // If no 'Retry-After' header, use our patient exponential backoff.
                    // Increased initial delay for rate limits without guidance.
                    delay = (initialDelay * 2) * Math.pow(2, attempt) + (Math.random() * 1000);
                    console.log(`Rate limit hit. No 'Retry-After' header found. Using patient exponential backoff.`);
                }
            } else {
                 // Standard Exponential Backoff for Server-Side Errors (5xx) or unknown errors.
                 const backoff = Math.pow(2, attempt);
                 const jitter = Math.random() * 1000;
                 delay = initialDelay * backoff + jitter;
            }

            console.log(`Retrying in ${Math.round(delay / 1000)}s...`);
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
 * Smartly fetches a WordPress API endpoint. It first attempts a direct connection.
 * If that fails (e.g., due to a CORS error, which is common for authenticated API calls
 * from a browser), it falls back to a series of public CORS proxies as a last resort.
 * This makes the connection for authenticated actions like image uploads significantly more resilient.
 * @param targetUrl The full URL to the WordPress API endpoint.
 * @param options The options for the fetch call (method, headers, body).
 * @returns The successful Response object.
 * @throws {Error} if the direct connection and all proxies fail.
 */
const fetchWordPressWithRetry = async (targetUrl: string, options: RequestInit): Promise<Response> => {
    const REQUEST_TIMEOUT = 30000; // 30 seconds for potentially large uploads
    let lastError: Error | null = null;

    // --- Attempt 1: Direct Connection (Preferred Method) ---
    // This is the ideal path and works if the WordPress server has correct CORS headers.
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        const directResponse = await fetch(targetUrl, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        // We return the response even on HTTP errors (like 403 Forbidden) because the connection
        // itself succeeded. The calling function needs to handle the specific API error.
        // A successful connection is anything that doesn't throw a network error (like TypeError for CORS).
        console.log("Direct connection to WordPress API successful.");
        return directResponse;

    } catch (error: any) {
        if (error.name === 'AbortError') {
            lastError = new Error("Direct WordPress API request timed out.");
        } else if (error instanceof TypeError && error.message.toLowerCase().includes('failed to fetch')) {
            // This is the classic browser error for a CORS-blocked request, which is the problem we are fixing.
            console.warn("Direct WP API call failed. This is likely a CORS issue. Falling back to proxies...");
            lastError = new Error("Direct connection blocked by CORS policy. Trying proxies as a fallback.");
        } else {
            console.warn("Direct WP API call failed with an unexpected error. Falling back to proxies...", error);
            lastError = error;
        }
    }

    // --- Attempt 2: Fallback to CORS Proxies (The Fix) ---
    // This is the workaround for servers without proper CORS configuration.
    // It may not work with all proxies, but it provides a chance for the request to succeed.
    console.log("Attempting to bypass CORS using proxies for the authenticated request...");
    const encodedUrl = encodeURIComponent(targetUrl);
    
    // Using a curated list of proxies that are more likely to respect headers.
    const proxies = [
        `https://corsproxy.io/?${targetUrl}`,
        `https://thingproxy.freeboard.io/fetch/${targetUrl}`,
    ];

    for (const proxyUrl of proxies) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const shortProxyUrl = new URL(proxyUrl).hostname;
            console.log(`Attempting WP API call via proxy: ${shortProxyUrl}`);

            // Important: We pass the ORIGINAL options, including the Authorization header.
            const response = await fetch(proxyUrl, { ...options, signal: controller.signal });

            // As before, we return the response even for HTTP errors (4xx, 5xx) because the connection worked.
            console.log(`Successfully connected via proxy: ${shortProxyUrl}`);
            return response;

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

    // If we're here, both the direct attempt and all proxies have failed.
    throw lastError || new Error("All attempts to connect to the WordPress API failed. Please check your server's CORS configuration and network connection.");
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
 * The "Link Uniqueness Guardian": Scans the content for duplicate internal link placeholders
 * (pointing to the same slug) and removes all but the first occurrence. This ensures
 * that each blog post is linked to only once, which is a critical SEO best practice.
 * @param content The HTML content string with potential duplicate link placeholders.
 * @returns The HTML content with duplicate links removed.
 */
const deduplicateInternalLinks = (content: string): string => {
    const placeholderRegex = /\[INTERNAL_LINK\s+slug="([^"]+)"\s+text="([^"]+)"\]/g;
    const seenSlugs = new Set<string>();

    return content.replace(placeholderRegex, (fullMatch, slug, text) => {
        if (seenSlugs.has(slug)) {
            // This is a duplicate link. Remove the placeholder and just keep the anchor text.
            console.warn(`[Link Deduplication] Found duplicate link for slug "${slug}". Removing placeholder, keeping text: "${text}".`);
            return text; // Return only the anchor text.
        } else {
            // This is the first time we've seen this slug. Keep it and record it.
            seenSlugs.add(slug);
            return fullMatch; // Return the original placeholder unchanged.
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

    if (lowerKeyword.includes('legal') || lowerKeyword.includes('compliance') || lowerKeyword.includes('law')) {
        authorCreds = "Legal Tech Analyst";
        factCheckerCreds = "Corporate Attorney, J.D.";
    } else if (lowerKeyword.includes('finance') || lowerKeyword.includes('investing') || lowerKeyword.includes('retirement')) {
        authorCreds = "Certified Financial Planner (CFP®)";
        factCheckerCreds = "Chartered Financial Analyst (CFA)";
    } else if (lowerKeyword.includes('health') || lowerKeyword.includes('medical') || lowerKeyword.includes('fitness')) {
        authorCreds = "Medical Writer & Health Educator";
        factCheckerCreds = "Board-Certified Physician, M.D.";
    } else if (lowerKeyword.includes('marketing') || lowerKeyword.includes('seo')) {
        authorCreds = "Certified Digital Marketing Consultant";
        factCheckerCreds = "Data Scientist, Marketing Analytics";
    } else if (lowerKeyword.includes('tech') || lowerKeyword.includes('software') || lowerKeyword.includes('coding')) {
        authorCreds = "Senior Technology Journalist";
        factCheckerCreds = "Principal Software Engineer";
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

const injectRankingTriggers = (data: GeneratedContent): GeneratedContent => {
    const powerWords = ['Ultimate', 'Proven', 'Secret', '2025', 'Expert-Tested'];
    const freshnessStamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    let title = data.title;

    const hasPowerWord = powerWords.some(w => title.toLowerCase().includes(w.toLowerCase()));
    if (!hasPowerWord) {
        title = `${powerWords[Math.floor(Math.random() * powerWords.length)]} ${title}`;
    }
    
    // Add freshness stamp if it doesn't already have a year
    if (!/\d{4}/.test(title)) {
        title = `${title} (${freshnessStamp})`;
    }

    data.title = title;
    return data;
};

const PROMPT_TEMPLATES = {
    contentTemplates: {
        'product-review': {
            outline: [
                'What is [PRODUCT]?',
                '[PRODUCT] vs Competitors',
                'Key Features & Benefits',
                'Pricing Analysis',
                'Real User Reviews',
                'Final Verdict'
            ],
        },
        'how-to-guide': {
            outline: [
                'Quick Answer (30s)',
                'Step-by-Step Process',
                'Common Mistakes to Avoid',
                'Pro Tips for Success',
                'Troubleshooting Common Issues'
            ]
        },
        'standard': null,
    },
    cluster_planner: {
        systemInstruction: `You are a master SEO strategist specializing in building topical authority through pillar-and-cluster content models. Your task is to analyze a user's broad topic and generate a complete, SEO-optimized content plan that addresses user intent at every stage.

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object. Do not include any text before or after the JSON.
2.  **FRESHNESS & ACCURACY:** All titles must reflect current trends and be forward-looking (e.g., use '2025' where appropriate).
3.  **Pillar Content:** The 'pillarTitle' must be a broad, comprehensive title for a definitive guide. It must be engaging, keyword-rich, and promise immense value. Think "The Ultimate Guide to..." or "Everything You Need to Know About...".
4.  **Cluster Content:** The 'clusterTitles' must be an array of 5 to 7 unique strings. Each title should be a compelling question or a long-tail keyword phrase that a real person would search for. These should be distinct sub-topics that logically support and link back to the main pillar page.
    - Good Example: "How Much Does Professional Landscaping Cost in 2025?"
    - Bad Example: "Landscaping Costs"
5.  **SERP Feature Targeting**: For each cluster title, specify which SERP feature it is designed to capture (e.g., "Featured Snippet", "People Also Ask", "Video Carousel").
{{GEO_TARGET_INSTRUCTIONS}}
6.  **JSON Structure:** The JSON object must conform to this exact structure:
    {
      "pillarTitle": "A comprehensive, SEO-optimized title for the main pillar article.",
      "clusterPlan": [
        {
          "title": "A specific, long-tail keyword-focused title for the first cluster article.",
          "targetSerpFeature": "Featured Snippet"
        },
        {
          "title": "A specific, question-based title for the second cluster article.",
          "targetSerpFeature": "People Also Ask"
        },
        "..."
      ]
    }`,
        userPrompt: (topic: string) => `Generate a pillar-and-cluster content plan for the topic: "${topic}".`
    },
    // ADD this new prompt to your PROMPT_TEMPLATES object
content_brief_generator: {
    systemInstruction: `You are a world-class SEO content strategist. Your mission is to create a detailed "Content Brief" that will serve as the strategic blueprint for an article guaranteed to rank #1. You will perform a deep analysis of the primary keyword and the provided SERP competitor data to define a winning strategy.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your ENTIRE response MUST be a single, valid JSON object. No conversational text.
2.  **DEEP COMPETITOR ANALYSIS:** Your analysis must be ruthless and insightful. Go beyond surface-level observations. Identify the exact weaknesses and content gaps in the top 10 results.
3.  **JSON STRUCTURE:** Adhere strictly to this structure:
    {
      "targetAudience": "A detailed description of the primary and secondary target audience, including their knowledge level, goals, and what motivates them.",
      "userPainPoints": "A list of 2-3 specific, high-intent problems or questions the user has that this article MUST solve better than anyone else.",
      "uniqueAngle": "A compelling, unique angle or hook that will make this article stand out. What new value, perspective, or data does it provide that competitors don't? This is your core strategic advantage.",
      "entitiesToCover": "A list of 5-7 essential named entities, concepts, technical terms, or sub-topics that MUST be included to demonstrate comprehensive expertise and topical authority.",
      "competitorWeaknesses": "A bulleted list summarizing the top 3 competitors' most critical weaknesses based on their SERP snippets and titles. Identify content gaps, outdated information (e.g., referencing 2023/2024), low-quality advice, or poor user experience signals."
    }`,
    userPrompt: (primaryKeyword: string, serpData: any[] | null) => `
**PRIMARY KEYWORD:** "${primaryKeyword}"
${serpData ? `**TOP 10 SERP COMPETITOR DATA (FOR ANALYSIS):** <serp_data>${JSON.stringify(serpData.map(d => ({title: d.title, link: d.link, snippet: d.snippet?.substring(0, 200)})))}</serp_data>` : ''}

Generate the complete JSON content brief.`
},
    content_meta_and_outline: {
        systemInstruction: `You are an ELITE content strategist and SEO expert, specializing in creating content that ranks for featured snippets and voice search. Your task is to generate ALL metadata and a comprehensive structural plan for a world-class article, based on a strategic content brief.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your ENTIRE response MUST be a single, valid JSON object. No text before or after.
2.  **STRATEGIC BRIEF IS LAW:** You MUST incorporate ALL recommendations from the provided 'Content Brief' into the new title, outline, and metadata. This is your highest priority.
3.  **AEO & ANSWER-FIRST STRUCTURE:** The introduction MUST provide a direct, concise answer to the primary user query within the first 50 words. All H2 headings in the outline MUST be phrased as direct user questions. This is critical for voice search and featured snippets.
4.  **DO NOT WRITE THE ARTICLE BODY:** Your role is to plan, not write. The 'outline' should be a list of H2 headings ONLY. The 'introduction' and 'conclusion' sections should be fully written paragraphs.
5.  **PRIORITIZE PAA:** If provided, you MUST prioritize using the 'People Also Ask' questions for the outline.
6.  **WRITING STYLE (For Intro/Conclusion):** Follow the "ANTI-AI" protocol: Short, direct sentences (avg. 10 words). Tiny paragraphs (2-3 sentences max). Active voice. Your writing MUST achieve a Flesch-Kincaid readability score of 80 or higher.
7.  **STRUCTURAL REQUIREMENTS:**
    - **keyTakeaways**: Exactly 8 high-impact bullet points (as an array of strings).
    - **outline**: 10-15 H2 headings, phrased as questions (as an array of strings).
    - **faqSection**: Exactly 8 questions for a dedicated FAQ section (as an array of objects: \`[{ "question": "..." }]\`).
    - **imageDetails**: Exactly 2 image prompts. Placeholders MUST be '[IMAGE_1_PLACEHOLDER]' and '[IMAGE_2_PLACEHOLDER]'. The 'prompt' MUST be a vivid, detailed description for an AI image generator. The 'altText' MUST be a highly descriptive, SEO-friendly sentence.
8.  **SOTA SEO METADATA:** The 'title' MUST be under 60 characters and contain the **exact** primary keyword. The 'metaDescription' MUST be between 120 and 155 characters and contain the **exact** primary keyword.
9.  **JSON STRUCTURE:** Adhere strictly to the provided JSON schema. Ensure all fields are present.
`,
        userPrompt: (primaryKeyword: string, semanticKeywords: string[] | null, serpData: any[] | null, peopleAlsoAsk: string[] | null, existingPages: any[] | null, originalContent: string | null = null, analysis: SitemapPage['analysis'] | null = null, contentBrief: any | null = null, contentTemplate: any | null = null) => {
            const MAX_CONTENT_CHARS = 8000;
            const MAX_LINKING_PAGES = 50;
            const MAX_SERP_SNIPPET_LENGTH = 200;

            let briefForPrompt = contentBrief ? `***CRITICAL CONTENT BRIEF:*** You MUST follow this strategic brief to guide your planning.
<content_brief>
${JSON.stringify(contentBrief, null, 2)}
</content_brief>` : '';

            let analysisForPrompt = analysis
                ? `***CRITICAL REWRITE ANALYSIS:*** You MUST follow these strategic recommendations to improve the article. This is your highest priority.
<rewrite_plan>
${JSON.stringify(analysis, null, 2)}
</rewrite_plan>`
                : '';
            
            let contentForPrompt = originalContent 
                ? `***CRITICAL REWRITE MANDATE:*** You are to deconstruct the following outdated article and rebuild its plan.
<original_content_to_rewrite>
${originalContent.substring(0, MAX_CONTENT_CHARS)}
</original_content_to_rewrite>`
                : '';
            
            let templateForPrompt = contentTemplate
                ? `***CONTENT TEMPLATE:*** You MUST use this outline structure. Replace placeholders like [PRODUCT] with the primary keyword. <template>${JSON.stringify(contentTemplate.outline)}</template>`
                : '';

            return `
**PRIMARY KEYWORD:** "${primaryKeyword}"
${briefForPrompt}
${analysisForPrompt}
${contentForPrompt}
${templateForPrompt}
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
2.  **ANSWER FIRST (FOR SNIPPETS):** The very first paragraph MUST be a direct, concise answer (40-55 words) to the question in the section heading. This is non-negotiable for AEO.
3.  **WORD COUNT:** The entire section MUST be between 250 and 300 words. This is mandatory.
4.  **ELITE WRITING STYLE (THE "ANTI-AI" PROTOCOL):**
    - Short, direct sentences. Average 10 words. Max 15.
    - Tiny paragraphs. 2-3 sentences. MAXIMUM.
    - Your writing MUST be clear enough to achieve a Flesch-Kincaid readability score of 80 or higher (Easy to read for a 12-year-old).
    - Use contractions: "it's," "you'll," "can't."
    - Active voice. Simple language. No filler words.
5.  **PERSONA ADOPTION:** You MUST adopt the persona of a seasoned expert relevant to the article's topic. For example, for "retirement planning," write as a financial advisor. For "SEO," as a digital marketing strategist. Your tone must be authoritative and trustworthy.
6.  **FRESHNESS RULE:** All information, stats, and examples MUST be current and forward-looking (2025 and beyond). Outdated information is forbidden.
7.  **FORBIDDEN PHRASES (ZERO TOLERANCE):**
    - ❌ 'delve into', 'in today's digital landscape', 'revolutionize', 'game-changer', 'unlock', 'leverage', 'in conclusion', 'to summarize', 'utilize', 'furthermore', 'moreover', 'landscape', 'realm', 'dive deep', etc.
8.  **STRUCTURE & SEO:**
    - You MAY use \`<h3>\` tags for sub-headings.
    - You MUST include at least one HTML table (\`<table>\`), list (\`<ul>\`/\`<ol>\`), or blockquote (\`<blockquote>\`) if relevant to the topic.
    - You MUST naturally integrate 1-2 internal link placeholders where contextually appropriate: \`[INTERNAL_LINK slug="example-slug" text="anchor text"]\`.
    - **EXPERT QUOTES:** If the provided SERP competitor snippets contain a relevant quote, you MAY insert it into the article as a \`<blockquote>\`, citing the source URL. Example: \`<blockquote>"This is an insightful quote." - Source: https://example.com/article</blockquote>\`
`,
        userPrompt: (primaryKeyword: string, articleTitle: string, sectionHeading: string, existingPages: any[] | null, serpData: any[] | null) => `
**Primary Keyword:** "${primaryKeyword}"
**Main Article Title:** "${articleTitle}"
**Section to Write:** "${sectionHeading}"

${existingPages && existingPages.length > 0 ? `**Available Internal Links:** You can link to these pages.\n<pages>${JSON.stringify(existingPages.slice(0, 50).map(p => ({slug: p.slug, title: p.title})))}</pages>` : ''}
${serpData ? `**Competitor Snippets (for quote inspiration):**\n<serp_data>${JSON.stringify(serpData.map(d => ({ snippet: d.snippet, link: d.link })))}</serp_data>`: ''}

Write the HTML content for this section now.
`
    },
    write_faq_section: {
        systemInstruction: `You are an expert content writer. Your task is to provide clear, concise, and helpful answers to a list of FAQ questions.

**RULES:**
1.  **JSON OUTPUT ONLY:** Your response MUST be a single, valid JSON object.
2.  **JSON STRUCTURE:** The JSON object must be \`{ "faqs": [{ "question": "...", "answer": "..." }] }\`. The 'answer' should be a single HTML paragraph string (\`<p>...\</p>\`).
3.  **STYLE & FRESHNESS:** Each answer must be direct, easy to understand (Flesch-Kincaid score of 80+), and typically 2-4 sentences long. All information must be up-to-date (2025+). Follow the "ANTI-AI" writing style (simple words, active voice).
4.  **MAINTAIN ORDER:** The order of the FAQs in your response MUST match the order of the questions provided in the prompt.`,
        userPrompt: (questions: string[]) => `Here is the list of questions:\n${JSON.stringify(questions)}\n\nGenerate the JSON object with all the answers now.`
    },
    semantic_keyword_generator: {
        systemInstruction: `You are a world-class SEO analyst. Your task is to generate a comprehensive list of semantic and LSI (Latent Semantic Indexing) keywords related to a primary topic, based on the provided competitor data.

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object.
2.  **QUANTITY:** Generate between 15 and 25 highly relevant keywords.
3.  **JSON STRUCTURE:** The JSON object must conform to this exact structure:
    {
      "semanticKeywords": [
        "A highly relevant LSI keyword.",
        "A long-tail question-based keyword.",
        "Another related keyword or phrase."
      ]
    }

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object.`,
        userPrompt: (primaryKeyword: string) => `Generate semantic keywords for the primary topic: "${primaryKeyword}".`
    },
    keyword_idea_generator: {
        systemInstruction: `You are an expert SEO strategist specializing in identifying low-competition, high-demand keywords. Your task is to generate a list of long-tail and question-based keywords for a given topic.

**RULES:**
1.  **Output Format:** Your entire response MUST be a single, valid JSON object. No text before or after the JSON.
2.  **Keyword Types:** Generate a mix of keyword types:
    - **Question Keywords:** Start with "who, what, where, when, why, how".
    - **Transactional Keywords:** Include terms like "buy", "best", "review", "vs", "alternative".
    - **Informational Long-Tail:** Detailed phrases a user would search for.
{{GEO_TARGET_INSTRUCTIONS}}
3.  **Quantity:** Generate between 20 and 30 unique keyword ideas.
4.  **JSON STRUCTURE:** The JSON object must conform to this exact structure:
    {
      "keywords": [
        "a long-tail keyword idea",
        "what is a question-based keyword idea",
        "..."
      ]
    }

**FINAL INSTRUCTION:** Your ENTIRE response MUST be ONLY the JSON object, starting with { and ending with }.`,
        userPrompt: (topic: string) => `Generate long-tail and question-based keyword ideas for the topic: "${topic}".`
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
{{GEO_TARGET_INSTRUCTIONS}}
5.  **Competitor Analysis:** Analyze the provided SERP competitor titles to identify patterns and find an angle to differentiate your metadata.
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

type KeywordResult = {
    keyword: string;
    competition: string;
    score: number;
    serp: any[];
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
    | { type: 'ADD_ITEMS'; payload: Partial<ContentItem>[] }
    | { type: 'UPDATE_STATUS'; payload: { id: string; status: ContentItem['status']; statusText: string } }
    | { type: 'SET_CONTENT'; payload: { id: string; content: GeneratedContent } }
    | { type: 'SET_CRAWLED_CONTENT'; payload: { id: string; content: string } };

const itemsReducer = (state: ContentItem[], action: ItemsAction): ContentItem[] => {
    switch (action.type) {
        case 'SET_ITEMS':
            return action.payload.map((item: any) => ({ ...item, status: 'idle', statusText: 'Not Started', generatedContent: null, crawledContent: item.crawledContent || null, analysis: item.analysis || null }));
        case 'ADD_ITEMS':
             const newItems = action.payload.map((item: any) => ({ ...item, status: 'idle', statusText: 'Not Started', generatedContent: null, crawledContent: item.crawledContent || null, analysis: item.analysis || null }));
             const existingIds = new Set(state.map(item => item.id));
             return [...state, ...newItems.filter(item => !existingIds.has(item.id))];
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
            semanticKeywordCount: (semanticKeywords || []).reduce((acc, kw) => acc + (textContent.toLowerCase().match(new RegExp(escapeRegExp(kw.toLowerCase()), 'g')) || []).length, 0),
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
                                    {isRegenerating.title ? <div className="scanner-loader"></div> : 'Regenerate'}
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
                                    {isRegenerating.meta ? <div className="scanner-loader"></div> : 'Regenerate'}
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
                                <li key={item.id} className={`priority-${item.priority.toLowerCase()}`}>
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
    callAI: (promptKey: Exclude<keyof typeof PROMPT_TEMPLATES, 'contentTemplates'>, promptArgs: any[], responseFormat?: 'json' | 'html', useGrounding?: boolean) => Promise<string>;
    geoTargeting: ExpandedGeoTargeting;
    addToast: (message: string, type: 'success' | 'error') => void;
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

const ReviewModal = ({ item, onClose, onSaveChanges, wpConfig, wpPassword, onPublishSuccess, publishItem, callAI, geoTargeting, addToast }: ReviewModalProps) => {
    if (!item || !item.generatedContent) return null;

    const [activeTab, setActiveTab] = useState('Live Preview');
    const [editedSeo, setEditedSeo] = useState({ title: '', metaDescription: '', slug: '' });
    const [editedContent, setEditedContent] = useState('');
    const [debouncedEditedContent, setDebouncedEditedContent] = useState('');
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
            setDebouncedEditedContent(item.generatedContent.content);
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


    // Debounce content analysis
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedEditedContent(editedContent);
        }, 500); // 500ms debounce delay

        return () => {
            clearTimeout(handler);
        };
    }, [editedContent]);


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
        // This is where you'd add CSS for the premium preview
        // For demonstration, we'll rely on a wrapping class in the JSX.
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
                addToast('HTML copied to clipboard!', 'success');
            })
            .catch(err => {
                console.error('Failed to copy HTML: ', err);
                addToast('Failed to copy HTML.', 'error');
            });
    };

    const handleValidateSchema = () => {
        if (!item?.generatedContent?.jsonLdSchema) {
            addToast("Schema has not been generated for this item.", 'error');
            return;
        }
        try {
            const schemaString = JSON.stringify(item.generatedContent.jsonLdSchema, null, 2);
            const url = `https://search.google.com/test/rich-results?code=${encodeURIComponent(schemaString)}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error("Failed to validate schema:", error);
            addToast("Could not process schema for validation.", 'error');
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
            
            const geoPromptEnhancement = (geoTargeting.enabled && geoTargeting.location)
                ? `\n**GEO-TARGETING MANDATE:**\n- Primary location: ${geoTargeting.location}, ${geoTargeting.region}\n- Naturally include the location in the copy.`
                : '';

            const responseText = await callAI('seo_metadata_generator', [
                primaryKeyword, summary, strategy.targetAudience, competitorTitles, geoTargeting.enabled ? geoTargeting.location : null
            ], 'json');

            const { seoTitle, metaDescription } = JSON.parse(extractJson(responseText));

            if (field === 'title' && seoTitle) {
                setEditedSeo(prev => ({ ...prev, title: seoTitle }));
            }
            if (field === 'meta' && metaDescription) {
                setEditedSeo(prev => ({ ...prev, metaDescription: metaDescription }));
            }
            addToast(`Successfully regenerated ${field}!`, 'success');
        } catch (error: any) {
            console.error(`Failed to regenerate ${field}:`, error);
            addToast(`An error occurred while regenerating the ${field}.`, 'error');
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
                                editedContent={debouncedEditedContent}
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
                        <button className="btn btn-secondary" onClick={() => { onSaveChanges(item.id, editedSeo, editedContent); addToast('Changes saved locally!', 'success'); }}>Save Changes</button>
                        <button className="btn btn-secondary" onClick={handleCopyHtml}>Copy HTML</button>
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
                                    {publishState[item.id].status === 'publishing' && <><div className="scanner-loader"></div><span>Publishing...</span></>}
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


// --- View Components (Moved outside App component to fix rendering issues) ---

interface SetupViewProps {
    apiKeys: {
        openaiApiKey: string;
        anthropicApiKey: string;
        openrouterApiKey: string;
        serperApiKey: string;
        groqApiKey: string;
    };
    apiKeyStatus: Record<string, 'idle' | 'validating' | 'valid' | 'invalid'>;
    handleApiKeyChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    editingApiKey: string | null;
    setEditingApiKey: React.Dispatch<React.SetStateAction<string | null>>;
    selectedModel: string;
    setSelectedModel: React.Dispatch<React.SetStateAction<string>>;
    selectedGroqModel: string;
    setSelectedGroqModel: React.Dispatch<React.SetStateAction<string>>;
    openrouterModels: string[];
    handleOpenrouterModelsChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    useGoogleSearch: boolean;
    setUseGoogleSearch: React.Dispatch<React.SetStateAction<boolean>>;
    wpConfig: WpConfig;
    setWpConfig: React.Dispatch<React.SetStateAction<WpConfig>>;
    wpPassword: string;
    setWpPassword: React.Dispatch<React.SetStateAction<string>>;
    siteInfo: SiteInfo;
    setSiteInfo: React.Dispatch<React.SetStateAction<SiteInfo>>;
    geoTargeting: ExpandedGeoTargeting;
    setGeoTargeting: React.Dispatch<React.SetStateAction<ExpandedGeoTargeting>>;
}
const SetupView = memo(({ apiKeys, apiKeyStatus, handleApiKeyChange, editingApiKey, setEditingApiKey, selectedModel, setSelectedModel, selectedGroqModel, setSelectedGroqModel, openrouterModels, handleOpenrouterModelsChange, useGoogleSearch, setUseGoogleSearch, wpConfig, setWpConfig, wpPassword, setWpPassword, siteInfo, setSiteInfo, geoTargeting, setGeoTargeting }: SetupViewProps) => (
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
                        <input type="text" id="groq-model-select" value={selectedGroqModel} onChange={e => setSelectedGroqModel(e.target.value)} placeholder="e.g., llama3-70b-8192" />
                        <p className="help-text">Enter any model name compatible with the Groq API.</p>
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
));

interface StrategyViewProps {
    contentMode: string;
    setContentMode: React.Dispatch<React.SetStateAction<string>>;
    topic: string;
    setTopic: React.Dispatch<React.SetStateAction<string>>;
    primaryKeywords: string;
    setPrimaryKeywords: React.Dispatch<React.SetStateAction<string>>;
    sitemapUrl: string;
    setSitemapUrl: React.Dispatch<React.SetStateAction<string>>;
    isCrawling: boolean;
    crawlMessage: string;
    existingPages: SitemapPage[];
    hubSearchFilter: string;
    setHubSearchFilter: React.Dispatch<React.SetStateAction<string>>;
    hubStatusFilter: string;
    setHubStatusFilter: React.Dispatch<React.SetStateAction<string>>;
    hubSortConfig: {
        key: string;
        direction: 'asc' | 'desc';
    };
    handleHubSort: (key: string) => void;
    isAnalyzingHealth: boolean;
    healthAnalysisProgress: {
        current: number;
        total: number;
    };
    selectedHubPages: Set<string>;
    handleToggleHubPageSelect: (id: string) => void;
    handleToggleHubPageSelectAll: () => void;
    handleAnalyzeSelectedPages: () => Promise<void>;
    analyzableForRewrite: number;
    handleRewriteSelected: () => void;
    handleOptimizeLinksSelected: () => void;
    setViewingAnalysis: React.Dispatch<React.SetStateAction<SitemapPage | null>>;
    handleCrawlSitemap: () => Promise<void>;
    isGenerating: boolean;
    handleGenerateClusterPlan: () => Promise<void>;
    handleGenerateMultipleFromKeywords: () => void;
    imagePrompt: string;
    setImagePrompt: React.Dispatch<React.SetStateAction<string>>;
    numImages: number;
    setNumImages: React.Dispatch<React.SetStateAction<number>>;
    aspectRatio: string;
    setAspectRatio: React.Dispatch<React.SetStateAction<string>>;
    isGeneratingImages: boolean;
    imageGenerationError: string;
    generatedImages: {
        src: string;
        prompt: string;
    }[];
    handleGenerateImages: () => Promise<void>;
    handleDownloadImage: (base64Data: string, prompt: string) => void;
    addToast: (message: string, type: 'success' | 'error') => void;
    filteredAndSortedHubPages: SitemapPage[];
    keywordTopic: string;
    setKeywordTopic: React.Dispatch<React.SetStateAction<string>>;
    handleFindKeywords: () => Promise<void>;
    isFindingKeywords: boolean;
    keywordStatusText: string;
    keywordResults: KeywordResult[];
    handleAddKeywordsToQueue: (keywords: string[]) => void;
}
const StrategyView = memo(({ contentMode, setContentMode, topic, setTopic, primaryKeywords, setPrimaryKeywords, sitemapUrl, setSitemapUrl, isCrawling, crawlMessage, existingPages, hubSearchFilter, setHubSearchFilter, hubStatusFilter, setHubStatusFilter, hubSortConfig, handleHubSort, isAnalyzingHealth, healthAnalysisProgress, selectedHubPages, handleToggleHubPageSelect, handleToggleHubPageSelectAll, handleAnalyzeSelectedPages, analyzableForRewrite, handleRewriteSelected, handleOptimizeLinksSelected, setViewingAnalysis, handleCrawlSitemap, isGenerating, handleGenerateClusterPlan, handleGenerateMultipleFromKeywords, imagePrompt, setImagePrompt, numImages, setNumImages, aspectRatio, setAspectRatio, isGeneratingImages, imageGenerationError, generatedImages, handleGenerateImages, handleDownloadImage, addToast, filteredAndSortedHubPages, keywordTopic, setKeywordTopic, handleFindKeywords, isFindingKeywords, keywordStatusText, keywordResults, handleAddKeywordsToQueue }: StrategyViewProps) => (
    <div className="content-strategy-view">
        <div className="page-header">
            <h2 className="gradient-headline">2. Content Strategy & Planning</h2>
            <p>Choose your content creation method. Plan a full topic cluster, generate a single article from a keyword, or use the Content Hub to analyze and rewrite existing posts.</p>
        </div>
        <div className="tabs-container">
            <div className="tabs" role="tablist">
                <button className={`tab-btn ${contentMode === 'bulk' ? 'active' : ''}`} onClick={() => setContentMode('bulk')} role="tab">Bulk Content Planner</button>
                <button className={`tab-btn ${contentMode === 'single' ? 'active' : ''}`} onClick={() => setContentMode('single')} role="tab">Single Article</button>
                <button className={`tab-btn ${contentMode === 'keywordResearch' ? 'active' : ''}`} onClick={() => setContentMode('keywordResearch')} role="tab">Keyword Opportunity</button>
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
               <p className="help-text">Enter one or more specific primary keywords, each on a new line, to generate multiple articles at once.</p>
                <div className="form-group">
                   <label htmlFor="primaryKeywords">Primary Keywords (one per line)</label>
                   <textarea id="primaryKeywords" value={primaryKeywords} onChange={e => setPrimaryKeywords(e.target.value)} placeholder="e.g., best camera for landscape photography
how to edit photos in lightroom" rows={5}></textarea>
               </div>
               <button className="btn" onClick={handleGenerateMultipleFromKeywords} disabled={!primaryKeywords.trim()}>Go to Review &rarr;</button>
           </div>
       )}
       {contentMode === 'keywordResearch' && (
            <div className="tab-panel">
                <h3>Keyword Opportunity Analyzer</h3>
                <p className="help-text">Enter a broad topic to discover low-competition, high-demand keywords. We'll analyze the top SERP results to score each keyword's difficulty.</p>
                <div className="form-group">
                    <label htmlFor="keywordTopic">Topic</label>
                    <input type="text" id="keywordTopic" value={keywordTopic} onChange={e => setKeywordTopic(e.target.value)} placeholder="e.g., Sustainable Gardening" />
                </div>
                <button className="btn" onClick={handleFindKeywords} disabled={isFindingKeywords || !keywordTopic}>
                    {isFindingKeywords ? 'Analyzing...' : 'Find Keyword Opportunities'}
                </button>
                {isFindingKeywords && <div className="crawl-status" style={{marginTop: '1rem'}}>{keywordStatusText}</div>}
                {keywordResults.length > 0 && (
                    <div className="content-hub-table-container" style={{marginTop: '2rem'}}>
                        <table className="content-hub-table">
                            <thead>
                                <tr>
                                    <th>Keyword</th>
                                    <th>Competition</th>
                                    <th>Score</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {keywordResults.map(result => (
                                    <tr key={result.keyword}>
                                        <td>{result.keyword}</td>
                                        <td><span className={`badge competition-${result.competition.toLowerCase().replace(/\s/g,'')}`}>{result.competition}</span></td>
                                        <td>{result.score}/100</td>
                                        <td><button className="btn btn-small" onClick={() => handleAddKeywordsToQueue([result.keyword])}>+ Add to Queue</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
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
                                <button className="btn btn-secondary" onClick={handleOptimizeLinksSelected} disabled={selectedHubPages.size === 0}>Optimize Links ({selectedHubPages.size})</button>
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
                                            <a href={page.id} target="_blank" rel="noopener noreferrer">{page.title}</a>
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
                    {isGeneratingImages ? <><div className="scanner-loader"></div> Generating...</> : 'Generate Images'}
                </button>
                {imageGenerationError && <p className="error" style={{marginTop: '1rem'}}>{imageGenerationError}</p>}
                {generatedImages.length > 0 && (
                    <div className="image-assets-grid" style={{marginTop: '2rem'}}>
                        {generatedImages.map((image, index) => (
                            <div key={index} className="image-asset-card">
                                <img src={image.src} alt={image.prompt} loading="lazy" />
                                <div className="image-asset-details">
                                    <button className="btn btn-small" onClick={() => handleDownloadImage(image.src, image.prompt)}>Download</button>
                                    <button className="btn btn-small btn-secondary" onClick={() => { navigator.clipboard.writeText(image.prompt); addToast('Prompt copied!', 'success'); }}>Copy Prompt</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        )}
    </div>
));

interface ReviewViewProps {
    filter: string;
    setFilter: React.Dispatch<React.SetStateAction<string>>;
    isGenerating: boolean;
    selectedItems: Set<string>;
    handleGenerateSelected: () => void;
    items: ContentItem[];
    handleToggleSelect: (id: string) => void;
    handleToggleSelectAll: () => void;
    filteredAndSortedItems: ContentItem[];
    handleSort: (key: string) => void;
    setSelectedItemForReview: React.Dispatch<React.SetStateAction<ContentItem | null>>;
    handleGenerateSingle: (item: ContentItem) => void;
    handleStopGeneration: (itemId: string | null) => void;
    generationProgress: {
        current: number;
        total: number;
    };
    setIsBulkPublishModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
const ReviewView = memo(({ filter, setFilter, isGenerating, selectedItems, handleGenerateSelected, items, handleToggleSelect, handleToggleSelectAll, filteredAndSortedItems, handleSort, setSelectedItemForReview, handleGenerateSingle, handleStopGeneration, generationProgress, setIsBulkPublishModalOpen }: ReviewViewProps) => (
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
                        <th><input type="checkbox" onChange={handleToggleSelectAll} checked={selectedItems.size > 0 && selectedItems.size === filteredAndSortedItems.length && filteredAndSortedItems.length > 0} /></th>
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
));


// --- Main App Component ---
const App = () => {
    const [activeView, setActiveView] = useState('setup');
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'error' }[]>([]);

    const addToast = (message: string, type: 'success' | 'error') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(toast => toast.id !== id));
        }, 5000);
    };
    
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
    const [contentMode, setContentMode] = useState('bulk'); // 'bulk', 'single', 'imageGenerator'
    const [topic, setTopic] = useState('');
    const [primaryKeywords, setPrimaryKeywords] = useState('');
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
    const [keywordTopic, setKeywordTopic] = useState('');
    const [keywordResults, setKeywordResults] = useState<KeywordResult[]>([]);
    const [isFindingKeywords, setIsFindingKeywords] = useState(false);
    const [keywordStatusText, setKeywordStatusText] = useState('');


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
                    await callAiWithRetry(() => client.chat.completions.create({
                        model: selectedGroqModel,
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
    }, 500), [selectedGroqModel]);
    
     useEffect(() => {
        Object.entries(apiKeys).forEach(([key, value]) => {
            if (value) {
                validateApiKey(key.replace('ApiKey', ''), value as string);
            }
        });
    }, []);

    // Re-validate Groq key when the model changes to give user feedback
    useEffect(() => {
        if (selectedModel === 'groq' && apiKeys.groqApiKey) {
            validateApiKey('groq', apiKeys.groqApiKey);
        }
    }, [selectedModel, selectedGroqModel, apiKeys.groqApiKey, validateApiKey]);

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
            addToast("No pages selected to analyze.", 'error');
            return;
        }

        const client = apiClients[selectedModel as keyof typeof apiClients];
        if (!client) {
            addToast("API client not available. Please check your API key in Step 1.", 'error');
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

    const handlePlanRewrite = (page: SitemapPage) => {
        const newItem: ContentItem = { 
            id: page.id,
            title: page.title, 
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
            addToast("Please select one or more pages that have been successfully analyzed to plan a rewrite.", 'error');
            return;
        }

        const newItems: ContentItem[] = selectedPages.map(page => ({
            id: page.id,
            title: page.title,
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
            addToast("Please select one or more pages to optimize for internal links.", 'error');
            return;
        }
    
        const newItems: Partial<ContentItem>[] = selectedPages.map(page => ({
            id: page.id + '-link-optimizer', // Ensure unique ID
            title: `Link Optimizer for: ${page.title}`,
            type: 'link-optimizer',
            originalUrl: page.id,
        }));
        dispatch({ type: 'ADD_ITEMS', payload: newItems });
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
            const responseText = await callAI('cluster_planner', [topic], 'json');
            const parsedJson = JSON.parse(extractJson(responseText));
            
            const newItems: Partial<ContentItem>[] = [
                { id: parsedJson.pillarTitle, title: parsedJson.pillarTitle, type: 'pillar' },
                ...parsedJson.clusterPlan.map((item: any) => ({ id: item.title, title: item.title, type: 'cluster' }))
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
    
    const handleGenerateMultipleFromKeywords = () => {
        const keywords = primaryKeywords.split('\n').map(k => k.trim()).filter(Boolean);
        if (keywords.length === 0) return;

        const newItems: Partial<ContentItem>[] = keywords.map(keyword => ({
            id: keyword,
            title: keyword,
            type: 'standard'
        }));
        
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setActiveView('review');
    };

    const analyzeSearchIntent = (keyword: string, serpData: any) => {
        const intents: Record<string, string[]> = {
            informational: ['how', 'what', 'why', 'guide', 'tutorial', 'resource', 'ideas', 'tips'],
            transactional: ['buy', 'price', 'discount', 'best', 'top', 'cheap', 'for sale'],
            navigational: ['login', 'signup', 'official', 'website'],
            commercial: ['review', 'vs', 'comparison', 'alternative', 'best']
        };
        let detectedIntent = 'informational';
        for (const [intent, triggers] of Object.entries(intents)) {
            if (triggers.some(t => keyword.toLowerCase().includes(t))) {
                detectedIntent = intent;
                break;
            }
        }
        const titles = serpData.organic?.map((r: any) => r.title.toLowerCase()) || [];
        const intentMatches = titles.filter((t: string) =>
            intents[detectedIntent as keyof typeof intents].some(trigger => t.includes(trigger))
        ).length;
        return {
            intent: detectedIntent,
            opportunity: intentMatches < 3 
        };
    };

    const calculateCompetitionScore = (serpData: any, keyword: string): { score: number; competition: string } => {
        let score = 0;
        const organicResults = serpData.organic?.slice(0, 10) || [];
        if (organicResults.length === 0) return { score: 0, competition: 'N/A' };
    
        const highAuthorityDomains = ['wikipedia.org', 'forbes.com', 'nytimes.com', 'investopedia.com', 'healthline.com', 'webmd.com', 'techcrunch.com'];
        const lowAuthoritySignals = ['reddit.com', 'quora.com', 'pinterest.com', '/forum/', 'capterra.com', 'g2.com', 'sourceforge.net'];
        const govEduDomains = ['.gov', '.edu'];
    
        if (serpData.featuredSnippet) score += 15;
        if (serpData.knowledgeGraph) score += 10;
        if (serpData.peopleAlsoAsk?.length > 0) score += 5;
    
        organicResults.forEach((result: any, index: number) => {
            const rankWeight = 10 - index; 
            let resultScore = 0;
    
            try {
                const url = new URL(result.link);
                const domain = url.hostname.replace('www.', '');
                
                if (highAuthorityDomains.some(d => domain.includes(d))) resultScore += 2.5;
                if (govEduDomains.some(d => domain.endsWith(d))) resultScore += 3.5;
                if (lowAuthoritySignals.some(s => result.link.includes(s))) resultScore -= 2.0;
    
                if (result.title.toLowerCase().includes(keyword.toLowerCase())) resultScore += 1.5;
                if (decodeURIComponent(url.href).toLowerCase().includes(keyword.toLowerCase().replace(/\s/g, '-'))) resultScore += 1;
    
                score += Math.max(0, resultScore) * (rankWeight / 10);
            } catch (e) { /* invalid URL, ignore */ }
        });
        
        const { opportunity } = analyzeSearchIntent(keyword, serpData);
        if (opportunity) {
            score *= 0.5; // Lower score = lower competition = better opportunity
        }
    
        const maxPossibleScore = 15 + 10 + 5 + 10 * 7.5; 
        const normalizedScore = Math.min(100, Math.round((score / maxPossibleScore) * 120));
    
        let competition = 'Very High';
        if (normalizedScore <= 20) competition = 'Very Low';
        else if (normalizedScore <= 40) competition = 'Low';
        else if (normalizedScore <= 60) competition = 'Medium';
        else if (normalizedScore <= 80) competition = 'High';
    
        return { score: normalizedScore, competition };
    };
    
    const extractKeywordsWithTFIDF = (html: string): string[] => {
        const text = html.replace(/<[^>]+>/g, ' ').toLowerCase();
        const words = text.match(/\b\w{4,}\b/g) || [];
        const wordFreq: Record<string, number> = {};
        words.forEach(word => {
            wordFreq[word] = (wordFreq[word] || 0) + 1;
        });
        return Object.entries(wordFreq)
            .filter(([word, freq]) => freq < 5 && word.length > 6)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 20)
            .map(([word]) => word);
    };

    const findKeywordGaps = async (competitorUrls: string[]): Promise<KeywordResult[]> => {
        const gaps: KeywordResult[] = [];
        await processConcurrently(competitorUrls, async (url) => {
            try {
                const response = await fetchWithProxies(url);
                const html = await response.text();
                const keywords = extractKeywordsWithTFIDF(html);
                
                await processConcurrently(keywords.slice(0, 10), async (kw) => {
                     const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                        method: 'POST',
                        headers: { 'X-API-KEY': apiKeys.serperApiKey!, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ q: kw, num: 10 })
                    });
                    const serpData = await serperResponse.json();
                    const competition = calculateCompetitionScore(serpData, kw);

                    if (competition.score < 30 && (serpData.organic?.length || 0) < 5) {
                        gaps.push({
                            keyword: kw,
                            score: competition.score,
                            competition: competition.competition,
                            serp: serpData.organic || []
                        });
                    }
                }, 5);
            } catch (e) {
                console.warn(`Failed to analyze ${url} for gaps:`, e);
            }
        }, 3);

        return gaps.sort((a, b) => a.score - b.score);
    };

    const handleFindKeywords = async () => {
        if (!apiClients[selectedModel as keyof typeof apiClients]) {
            addToast('Please configure the selected AI model API key in Setup.', 'error');
            return;
        }
        if (!apiKeys.serperApiKey) {
            addToast('Please configure the Serper API key in Setup to use this feature.', 'error');
            return;
        }
        setIsFindingKeywords(true);
        setKeywordResults([]);
        
        try {
            setKeywordStatusText('Stage 1/4: Generating initial keyword ideas...');
            const ideasText = await callAI('keyword_idea_generator', [keywordTopic], 'json');
            const { keywords } = JSON.parse(extractJson(ideasText));

            setKeywordStatusText('Stage 2/4: Analyzing SERP for competitor gap analysis...');
            const mainSerperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                method: 'POST', headers: { 'X-API-KEY': apiKeys.serperApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: keywordTopic, num: 10 })
            });
            const mainSerpData = await mainSerperResponse.json();
            const competitorUrls = mainSerpData.organic?.map((r: any) => r.link).slice(0, 3) || [];
            
            setKeywordStatusText('Stage 3/4: Mining competitors for keyword gaps...');
            const gapKeywords = await findKeywordGaps(competitorUrls);

            const allKeywords = [...new Set([...keywords, ...gapKeywords.map(k => k.keyword)])];
            const precomputedGaps = new Map(gapKeywords.map(k => [k.keyword, k]));
            
            setKeywordStatusText(`Stage 4/4: Analyzing SERPs for ${allKeywords.length} keywords...`);
            
            const results: KeywordResult[] = [];
            await processConcurrently(allKeywords, async (keyword: string) => {
                if (precomputedGaps.has(keyword)) {
                    results.push(precomputedGaps.get(keyword)!);
                    return;
                }
                try {
                    const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                        method: 'POST', headers: { 'X-API-KEY': apiKeys.serperApiKey!, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ q: keyword, num: 20 })
                    });
                    if (!serperResponse.ok) throw new Error(`Serper API failed with status ${serperResponse.status}`);
                    const serpData = await serperResponse.json();
                    const { score, competition } = calculateCompetitionScore(serpData, keyword);
                    results.push({ keyword, score, competition, serp: serpData.organic || [] });
                } catch (e: any) { console.error(`Failed to analyze keyword "${keyword}":`, e); }
            }, 5);
            
            results.sort((a, b) => a.score - b.score);
            setKeywordResults(results);

        } catch (error: any) {
            console.error("Error finding keywords:", error);
            addToast(`An error occurred: ${error.message}`, 'error');
        } finally {
            setIsFindingKeywords(false);
        }
    };
    
    const handleAddKeywordsToQueue = (keywords: string[]) => {
        const newItems: Partial<ContentItem>[] = keywords.map(keyword => ({
            id: keyword,
            title: keyword,
            type: 'standard'
        }));
        dispatch({ type: 'ADD_ITEMS', payload: newItems });
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

    const handleToggleSelect = useCallback((itemId: string) => {
        setSelectedItems(prev => {
            const newSet = new Set(prev);
            if (newSet.has(itemId)) {
                newSet.delete(itemId);
            } else {
                newSet.add(itemId);
            }
            return newSet;
        });
    }, []);

    // FIX: Moved `filteredAndSortedItems` before its usage in `handleToggleSelectAll` to prevent a reference error.
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

    const handleToggleSelectAll = useCallback(() => {
        if (selectedItems.size === filteredAndSortedItems.length) {
            setSelectedItems(new Set());
        } else {
            setSelectedItems(new Set(filteredAndSortedItems.map(item => item.id)));
        }
    }, [filteredAndSortedItems, selectedItems.size]);
    
    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

const runGenerationQueue = async (itemsToGenerate: ContentItem[]) => {
        setIsGenerating(true);
        setGenerationProgress({ current: 0, total: itemsToGenerate.length });
        
        // SOTA FIX: A configurable constant for concurrency. 
        // 5 was too high for your API plan, causing the 429 error.
        // Starting with 2 or 3 is a much safer approach to avoid rate limits.
        const MAX_CONCURRENT_JOBS = 3;

        await processConcurrently(
            itemsToGenerate,
            (item) => generateSingleItem(item),
            MAX_CONCURRENT_JOBS, // Use the new constant here
            (completed, total) => {
                setGenerationProgress({ current: completed, total: total });
            },
            () => {
                // Checks if any item has been flagged to stop the entire queue.
                const shouldStop = itemsToGenerate.some(item => stopGenerationRef.current.has(item.id));
                if (shouldStop) {
                    console.log("Stop signal received, halting generation queue.");
                }
                return shouldStop;
            }
        );

        setIsGenerating(false);
        stopGenerationRef.current.clear(); // Clear stop signals after the queue is finished
    };

    const handleGenerateSingle = (item: ContentItem) => {
        stopGenerationRef.current.delete(item.id);
        runGenerationQueue([item]);
    };

    const handleGenerateSelected = () => {
        stopGenerationRef.current.clear();
        const itemsToGenerate = items.filter(item => selectedItems.has(item.id));
        if (itemsToGenerate.length > 0) {
            runGenerationQueue(itemsToGenerate);
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
    
    // FIX: The `promptKey` type was too broad, causing a TypeScript error.
    // It's been narrowed to exclude 'contentTemplates', which doesn't fit the expected structure.
    const callAI = useCallback(async (
        promptKey: Exclude<keyof typeof PROMPT_TEMPLATES, 'contentTemplates'>,
        promptArgs: any[],
        responseFormat: 'json' | 'html' = 'json',
        useGrounding: boolean = false
    ): Promise<string> => {
        const client = apiClients[selectedModel as keyof typeof apiClients];
        if (!client) throw new Error(`API Client for '${selectedModel}' not initialized.`);
    
        const template = PROMPT_TEMPLATES[promptKey];
    
        const geoInstructions = (geoTargeting.enabled && geoTargeting.location)
            ? `\n**GEO-TARGETING MANDATE:**\n- Primary location: ${geoTargeting.location}, ${geoTargeting.region}\n- All content and titles must be tailored to this specific location.`
            : '';
    
        const systemInstruction = template.systemInstruction.replace('{{GEO_TARGET_INSTRUCTIONS}}', geoInstructions);
        
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

    const getContentTemplate = (keyword: string): string => {
        const lowerKeyword = keyword.toLowerCase();
        if (lowerKeyword.includes('review')) return 'product-review';
        if (lowerKeyword.includes('how to')) return 'how-to-guide';
        return 'standard';
    };

    const generateReferencesWithEnforcement = useCallback(async (
        title: string,
        primaryKeyword: string,
        contentSummary: string,
        initialSerpData: any[] | null
    ): Promise<any[]> => {
        console.log("[Reference Guardian] Starting reference generation...");
        let collectedReferences: any[] = [];
        const seenUrls = new Set<string>();

        const addReferences = (newRefs: any[]) => {
            for (const ref of newRefs) {
                if (ref && ref.url && !seenUrls.has(ref.url) && String(ref.url).startsWith('http')) {
                    seenUrls.add(ref.url);
                    collectedReferences.push(ref);
                }
            }
             console.log(`[Reference Guardian] Total unique references collected: ${collectedReferences.length}`);
        };

        // --- STAGE 1: High-Precision Grounded Search ---
        try {
            console.log("[Reference Guardian] Stage 1: Attempting high-precision grounded search.");
            const groundedText = await callAI('find_real_references', [title, contentSummary], 'json', true);
            addReferences(JSON.parse(extractJson(groundedText)));
        } catch (error: any) {
            console.warn("[Reference Guardian] Stage 1 (Grounded Search) failed or returned no results.", error.message);
        }

        if (collectedReferences.length >= 8) {
            console.log("[Reference Guardian] Quota met in Stage 1. Finalizing.");
            return collectedReferences.slice(0, 12);
        }

        // --- STAGE 2: SERP-Contextualized Search ---
        if (initialSerpData && initialSerpData.length > 0) {
            try {
                console.log("[Reference Guardian] Stage 2: Not enough refs. Attempting SERP-contextualized search.");
                const serpContextText = await callAI('find_real_references_with_context', [title, contentSummary, initialSerpData], 'json');
                addReferences(JSON.parse(extractJson(serpContextText)));
            } catch (error: any) {
                console.warn("[Reference Guardian] Stage 2 (SERP Context) failed.", error.message);
            }
        }

        if (collectedReferences.length >= 8) {
            console.log("[Reference Guardian] Quota met in Stage 2. Finalizing.");
            return collectedReferences.slice(0, 12);
        }

        // --- STAGE 3: Proactive Broad Search & Rescue ---
        console.log(`[Reference Guardian] Stage 3: Quota still not met (${collectedReferences.length}/8). Initiating proactive search & rescue.`);
        
        try {
            // Generate diverse search queries to cast a wide net
            const searchQueries = [
                `"${primaryKeyword}" study OR research`,
                `scientific review of "${title}"`,
                `"${primaryKeyword}" statistics 2025`,
                `expert analysis on "${primaryKeyword}"`,
                `"${primaryKeyword}" government report OR .gov`,
                `"${primaryKeyword}" university .edu research`
            ];

            let highQualitySearchResults: any[] = [];

            // Execute all searches concurrently
            await processConcurrently(searchQueries, async (query) => {
                try {
                    const searchResponse = await fetchWithProxies("https://google.serper.dev/search", {
                        method: 'POST',
                        headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ q: query, num: 5 })
                    });
                    if (searchResponse.ok) {
                        const jsonData = await searchResponse.json();
                        if (jsonData.organic) {
                            highQualitySearchResults.push(...jsonData.organic);
                        }
                    }
                } catch (e) {
                    console.warn(`[Reference Guardian] Search query failed: "${query}"`, e);
                }
            }, 3);

            if (highQualitySearchResults.length === 0) {
                 console.error("[Reference Guardian] Stage 3 failed to gather any search results.");
                 throw new Error("Broad search returned no results.");
            }
            
             console.log(`[Reference Guardian] Stage 3 gathered ${highQualitySearchResults.length} potential sources. Feeding to AI for formatting.`);

            // Feed the curated, high-quality search results to the AI for final formatting
            const rescueText = await callAI('find_real_references_with_context', [title, contentSummary, highQualitySearchResults], 'json');
            addReferences(JSON.parse(extractJson(rescueText)));

        } catch (error: any) {
            console.error("[Reference Guardian] Stage 3 (Search & Rescue) failed critically.", error.message);
        }
        
        // --- FINALIZATION ---
        if (collectedReferences.length < 8) {
            console.warn(`[Reference Guardian] WARNING: Could not meet the minimum reference quota. Final count: ${collectedReferences.length}. The article will proceed with the available references.`);
        } else {
             console.log(`[Reference Guardian] SUCCESS: Final reference count is ${collectedReferences.length}. Truncating to 12 if necessary.`);
        }
        
        return collectedReferences.slice(0, 12);
    }, [callAI, apiKeys.serperApiKey]);

    const generateSingleItem = useCallback(async (item: ContentItem) => {
        if (stopGenerationRef.current.has(item.id)) return;

        // 👇 --- ADD THIS NEW PRE-FLIGHT CHECK BLOCK --- 👇
        if (!apiKeys.serperApiKey || apiKeyStatus.serper !== 'valid') {
            const errorMessage = "Cannot generate references. The Serper API key is missing or invalid. Please configure it in Step 1 (Setup) to proceed.";
            dispatch({
                type: 'UPDATE_STATUS',
                payload: { id: item.id, status: 'error', statusText: errorMessage }
            });
            console.error(errorMessage);
            return; // Stop the function immediately.
        }
        // --- END OF NEW PRE-FLIGHT CHECK ---

        dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Initializing...' } });

        let rawResponseForDebugging: any = null;
        let processedContent: GeneratedContent | null = null;
        
        try {
            if (item.type === 'link-optimizer') {
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 1/2: Fetching original content...' } });
                if (!item.originalUrl) throw new Error("Original URL is missing for link optimization.");
                const pageResponse = await fetchWithProxies(item.originalUrl);
                const originalHtml = await pageResponse.text();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = originalHtml.replace(/<script[^>]*>.*?<\/script>/gi, '');
                const mainContentElement = tempDiv.querySelector('main, article, .main-content, #main, #content, .post-content, [role="main"]');
                if (!mainContentElement) throw new Error("Could not extract main content from the page to optimize.");
                const contentToOptimize = mainContentElement.innerHTML;
                
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 2/2: Optimizing Internal Links...' } });
                const optimizedContentHtml = await callAI('internal_link_optimizer', [contentToOptimize, existingPages], 'html');
                const finalOptimizedInnerContent = sanitizeHtmlResponse(optimizedContentHtml);
                const originalTitle = tempDiv.querySelector('title')?.textContent || item.title;
                const originalMetaDesc = tempDiv.querySelector('meta[name="description"]')?.getAttribute('content') || `Updated content for ${originalTitle}`;

                const finalContentPayload = normalizeGeneratedContent({
                    title: originalTitle, slug: extractSlugFromUrl(item.originalUrl!), metaDescription: originalMetaDesc,
                    content: finalOptimizedInnerContent, primaryKeyword: originalTitle, semanticKeywords: [], imageDetails: [],
                    strategy: { targetAudience: 'N/A', searchIntent: 'N/A', competitorAnalysis: 'N/A', contentAngle: 'Internal Link Optimization' },
                    jsonLdSchema: {}, socialMediaCopy: { twitter: '', linkedIn: '' }
                }, item.title);

                finalContentPayload.content = processInternalLinks(finalContentPayload.content, existingPages);
                finalContentPayload.jsonLdSchema = generateFullSchema(finalContentPayload, wpConfig, siteInfo, [], geoTargeting);
                dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: finalContentPayload } });
                return;
            }
             
            let serpData: any[] | null = null;
            let peopleAlsoAsk: string[] | null = null;
            let youtubeVideos: any[] | null = null;
            let contentBrief: any | null = null;
            let semanticKeywords: string[] | null = null;
            const isPillar = item.type === 'pillar';

            if (apiKeys.serperApiKey && apiKeyStatus.serper === 'valid') {
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 1/7: Fetching SERP Data...' } });
                const cacheKey = `serp-${item.title}`;
                const cachedSerp = apiCache.get(cacheKey);
                if (cachedSerp) {
                     serpData = cachedSerp.serpData; youtubeVideos = cachedSerp.youtubeVideos; peopleAlsoAsk = cachedSerp.peopleAlsoAsk;
                } else {
                    try {
                        const serperResponse = await fetchWithProxies("https://google.serper.dev/search", { method: 'POST', headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: item.title }) });
                        if (!serperResponse.ok) throw new Error(`Serper API failed with status ${serperResponse.status}`);
                        const serperJson = await serperResponse.json();
                        serpData = serperJson.organic ? serperJson.organic.slice(0, 10) : [];
                        peopleAlsoAsk = serperJson.peopleAlsoAsk ? serperJson.peopleAlsoAsk.map((p: any) => p.question) : [];
                        const videoCandidates = new Map<string, any>();
                        const videoQueries = [`"${item.title}" tutorial`, `how to ${item.title}`, item.title];
                        for (const query of videoQueries) {
                            if (videoCandidates.size >= 10) break;
                            try {
                                const videoResponse = await fetchWithProxies("https://google.serper.dev/videos", { method: 'POST', headers: { 'X-API-KEY': apiKeys.serperApiKey as string, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query }) });
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
                    } catch (serpError) { console.error("Failed to fetch SERP data:", serpError); }
                }
            }
            if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");

            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 2/7: Creating Content Brief...' } });
            const briefText = await callAI('content_brief_generator', [item.title, serpData], 'json');
            contentBrief = JSON.parse(extractJson(briefText));
            if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");

            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 3/7: Generating Semantic Keywords...' } });
            const skCacheKey = `sk-${item.title}`;
            if (apiCache.get(skCacheKey)) {
                semanticKeywords = apiCache.get(skCacheKey);
            } else {
                const skResponseText = await callAI('semantic_keyword_generator', [item.title], 'json');
                const parsedSk = JSON.parse(extractJson(skResponseText));
                semanticKeywords = parsedSk.semanticKeywords;
                apiCache.set(skCacheKey, semanticKeywords);
            }
            if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");

            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Stage 4/7: Generating Article Outline...' } });
            const templateName = getContentTemplate(item.title);
            const contentTemplate = PROMPT_TEMPLATES.contentTemplates[templateName as keyof typeof PROMPT_TEMPLATES.contentTemplates];
            const outlineResponseText = await callAI('content_meta_and_outline', [item.title, semanticKeywords, serpData, peopleAlsoAsk, existingPages, item.crawledContent, item.analysis, contentBrief, contentTemplate], 'json', useGoogleSearch);
            rawResponseForDebugging = outlineResponseText;
            const metaAndOutline = JSON.parse(extractJson(outlineResponseText));
            metaAndOutline.introduction = sanitizeHtmlResponse(metaAndOutline.introduction);
            metaAndOutline.conclusion = sanitizeHtmlResponse(metaAndOutline.conclusion);

            let contentParts: string[] = [metaAndOutline.introduction, `<h3>Key Takeaways</h3>\n<ul>\n${metaAndOutline.keyTakeaways.map((t: string) => `<li>${t}</li>`).join('\n')}\n</ul>`];
            const sections = metaAndOutline.outline;
            for (let i = 0; i < sections.length; i++) {
                if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 5/7: Writing section ${i + 1} of ${sections.length}...` } });
                let sectionContent = `<h2>${sections[i]}</h2>`;
                const sectionHtml = await callAI('write_article_section', [item.title, metaAndOutline.title, sections[i], existingPages, serpData], 'html');
                sectionContent += sanitizeHtmlResponse(sectionHtml);
                contentParts.push(sectionContent);
                if (youtubeVideos?.length) {
                    if (i === 1 && youtubeVideos[0]) contentParts.push(`<div class="video-container"><iframe width="100%" height="410" src="${youtubeVideos[0].embedUrl}" title="${youtubeVideos[0].title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`);
                    if (i === Math.floor(sections.length / 2) && youtubeVideos[1]) contentParts.push(`<div class="video-container"><iframe width="100%" height="410" src="${youtubeVideos[1].embedUrl}" title="${youtubeVideos[1].title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`);
                }
            }
            contentParts.push(metaAndOutline.conclusion);
            const fullFaqData: { question: string, answer: string }[] = [];
            const faqQuestions = metaAndOutline.faqSection.map((faq: any) => faq.question);
            if (faqQuestions.length > 0) {
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 5/7: Answering ${faqQuestions.length} FAQs...` } });
                const faqResponseText = await callAI('write_faq_section', [faqQuestions], 'json');
                const { faqs: answeredFaqs } = JSON.parse(extractJson(faqResponseText));
                if (answeredFaqs?.length > 0) {
                    contentParts.push(`<div class="faq-section"><h2>Frequently Asked Questions</h2>`);
                    for (const faq of answeredFaqs) {
                        if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");
                        const cleanAnswer = sanitizeHtmlResponse(faq.answer).replace(/^<p>|<\/p>$/g, '');
                        contentParts.push(`<h3>${faq.question}</h3>\n<p>${cleanAnswer}</p>`);
                        fullFaqData.push({ question: faq.question, answer: cleanAnswer });
                    }
                    contentParts.push(`</div>`);
                }
            }
            if (stopGenerationRef.current.has(item.id)) throw new Error("Stopped by user");

            let finalContent = contentParts.join('\n\n');
            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 6/7: Generating Images...` } });
            const updatedImageDetails = [...metaAndOutline.imageDetails];
            for (let i = 0; i < updatedImageDetails.length; i++) {
                if (stopGenerationRef.current.has(item.id)) break;
                const imageDetail = updatedImageDetails[i];
                try {
                    const generatedImageSrc = await generateImageWithFallback(imageDetail.prompt);
                    if (generatedImageSrc) {
                        imageDetail.generatedImageSrc = generatedImageSrc;
                        finalContent = finalContent.replace(imageDetail.placeholder, `<figure class="wp-block-image size-large"><img src="${generatedImageSrc}" alt="${imageDetail.altText}" title="${imageDetail.title}"/><figcaption>${imageDetail.altText}</figcaption></figure>`);
                    } else finalContent = finalContent.replace(imageDetail.placeholder, '');
                } catch (imgError) {
                    console.error(`Failed to generate image for prompt: "${imageDetail.prompt}"`, imgError);
                    finalContent = finalContent.replace(imageDetail.placeholder, '');
                }
            }
            finalContent = finalContent.replace(/\[IMAGE_\d_PLACEHOLDER\]/g, '');
            
// --- NEW SOTA "REFERENCE GUARDIAN" SYSTEM ---
            dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `Stage 7/7: Finding Sources & Finalizing...` } });
            const contentSummaryForRefs = finalContent.replace(/<[^>]+>/g, ' ').substring(0, 2000);

            const references = await generateReferencesWithEnforcement(
                metaAndOutline.title,
                metaAndOutline.primaryKeyword,
                contentSummaryForRefs,
                serpData
            );

            if (references && references.length > 0) {
                let referencesHtml = '<h2>References</h2>\n<ol>\n';
                for (const ref of references) {
                     // Final validation check before rendering
                    if (ref.title && ref.url && ref.source && ref.year) {
                        referencesHtml += `<li><a href="${ref.url}" target="_blank" rel="noopener noreferrer">${ref.title.replace(/</g, '&lt;')}</a> (${ref.source.replace(/</g, '&lt;')}, ${ref.year})</li>\n`;
                    }
                }
                referencesHtml += '</ol>';
                finalContent += '\n\n' + referencesHtml;
            }
            // --- END OF NEW SYSTEM ---
            
// --- This is the NEW, FIXED code block ---
            finalContent = sanitizeBrokenPlaceholders(finalContent); // 1. Clean up malformed placeholders first.
            finalContent = deduplicateInternalLinks(finalContent);   // 2. NEW: Remove any duplicate links the AI created.
            finalContent = validateAndRepairInternalLinks(finalContent, existingPages); // 3. Repair any remaining invalid links.
            finalContent = enforceInternalLinkQuota(finalContent, existingPages, metaAndOutline.primaryKeyword, MIN_INTERNAL_LINKS); // 4. Add new links if needed (this already prevents adding duplicates).
            finalContent = processInternalLinks(finalContent, existingPages); // 5. Convert all valid placeholders to <a> tags.
            finalContent = enforceUniqueVideoEmbeds(finalContent, youtubeVideos || []);
            enforceWordCount(finalContent, isPillar ? TARGET_MIN_WORDS_PILLAR : TARGET_MIN_WORDS, isPillar ? TARGET_MAX_WORDS_PILLAR : TARGET_MAX_WORDS);
            checkHumanWritingScore(finalContent);
            
            processedContent = normalizeGeneratedContent({ ...metaAndOutline, content: finalContent, imageDetails: updatedImageDetails, serpData }, item.title);
            processedContent = injectRankingTriggers(processedContent);
            processedContent.jsonLdSchema = generateFullSchema(processedContent, wpConfig, siteInfo, fullFaqData, geoTargeting);
            dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: processedContent } });
} catch (error: any) {
            console.error(`Error generating item "${item.title}":`, error);
            console.error("RAW AI RESPONSE FOR DEBUGGING:", rawResponseForDebugging);

            if (error instanceof ContentTooShortError) {
                const partialContent: GeneratedContent = normalizeGeneratedContent({
                    ...(processedContent || {}), 
                    title: item.title,
                    content: error.content, 
                }, item.title);

                dispatch({
                    type: 'SET_CONTENT',
                    payload: { id: item.id, content: partialContent }
                });
                dispatch({
                    type: 'UPDATE_STATUS',
                    payload: { id: item.id, status: 'error', statusText: `Content too short (${error.wordCount} words). Review required.` }
                });
            } else {
                 dispatch({
                    type: 'UPDATE_STATUS',
                    payload: { id: item.id, status: 'error', statusText: `Error: ${error.message.substring(0, 100)}` }
                });
            }
        } finally {
             stopGenerationRef.current.delete(item.id);
        }
    }, [callAI, existingPages, apiKeys.serperApiKey, apiKeyStatus.serper, wpConfig, siteInfo, geoTargeting, generateImageWithFallback]);

const publishItem = async (
        itemToPublish: ContentItem,
        currentWpPassword: string,
        status: 'publish' | 'draft' = 'publish'
    ): Promise<{ success: boolean; message: React.ReactNode; link?: string; }> => {
        const { generatedContent, originalUrl } = itemToPublish;
        if (!generatedContent) return { success: false, message: 'No content to publish.' };

        let { content, imageDetails, title, metaDescription, slug } = generatedContent;
        const isUpdate = !!originalUrl;

        const headers = new Headers({
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + btoa(`${wpConfig.username}:${currentWpPassword}`)
        });

        // --- STAGE 1: Resilient Image Upload ---
        try {
            for (let i = 0; i < imageDetails.length; i++) {
                const image = imageDetails[i];
                if (image.generatedImageSrc && image.generatedImageSrc.startsWith('data:')) {
                    const blob = await (await fetch(image.generatedImageSrc)).blob();
                    
                    const mediaHeaders = new Headers({
                        'Authorization': headers.get('Authorization')!,
                        'Content-Disposition': `attachment; filename="${image.title}.jpg"`,
                        'Content-Type': 'image/jpeg'
                    });

                    const mediaResponse = await fetchWordPressWithRetry(`${wpConfig.url}/wp-json/wp/v2/media`, {
                        method: 'POST',
                        headers: mediaHeaders,
                        body: blob
                    });

                    // --- NEW SOTA ERROR DIAGNOSTICS ---
                    if (!mediaResponse.ok) {
                        // This block now captures the TRUE error message from the server.
                        const errorText = await mediaResponse.text();
                        let errorMessage = `Server responded with status ${mediaResponse.status}.`;
                        
                        // Try to parse as JSON, but fall back to raw text if it fails (e.g., HTML from a security plugin).
                        try {
                            const errorJson = JSON.parse(errorText);
                            errorMessage = errorJson.message || JSON.stringify(errorJson);
                        } catch (e) {
                            // This is the key fix: It captures non-JSON errors.
                             const strippedError = errorText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                             errorMessage = `A server-side error occurred. The response was not valid JSON, which often indicates a security plugin (like Wordfence) or firewall is blocking the request. Server response snippet: "${strippedError.substring(0, 150)}..."`;
                        }
                        throw new Error(errorMessage);
                    }
                    // --- END OF NEW DIAGNOSTICS ---

                    const mediaData = await mediaResponse.json();
                    content = content.replace(new RegExp(escapeRegExp(image.generatedImageSrc), 'g'), mediaData.source_url);
                }
            }
        } catch (error: any) {
             // The error message passed here will now be highly specific and helpful.
             return { success: false, message: `Image upload failed: ${error.message}` };
        }

        // --- STAGE 2: Post Publishing ---
        const postData: any = {
            title,
            content,
            status: isUpdate ? 'publish' : status, // Updates should always be published.
            slug,
            meta: {
                _yoast_wpseo_title: title,
                _yoast_wpseo_metadesc: metaDescription,
            },
        };

        let endpoint = `${wpConfig.url}/wp-json/wp/v2/posts`;
        let method = 'POST';

        if (isUpdate) {
            try {
                const searchResponse = await fetchWordPressWithRetry(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${slug}&status=any&_fields=id`, { headers });
                if (!searchResponse.ok) throw new Error('Failed to search for the original post before updating.');
                const posts = await searchResponse.json();
                if (posts.length > 0) {
                    const postId = posts[0].id;
                    endpoint = `${wpConfig.url}/wp-json/wp/v2/posts/${postId}`;
                    method = 'POST'; // WordPress uses POST for updates on specific ID endpoints
                } else {
                    console.warn(`Could not find post with slug "${slug}" to update. A new post will be created instead.`);
                }
            } catch (e: any) {
                 return { success: false, message: `Could not find the original post to update. Error: ${e.message}` };
            }
        }

        try {
            const response = await fetchWordPressWithRetry(endpoint, {
                method,
                headers,
                body: JSON.stringify(postData)
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({ message: `WordPress API returned status ${response.status}`}));
                const errorMessage = errorBody.message || JSON.stringify(errorBody);
                throw new Error(errorMessage);
            }
            const data = await response.json();
            return {
                success: true,
                message: <a href={data.link} target="_blank" rel="noopener noreferrer">Successfully {isUpdate ? 'updated!' : 'published!'} View Post</a>,
                link: data.link
            };

        } catch (error: any) {
             return { success: false, message: `Publishing failed: ${error.message}` };
        }
    };

    const handleSaveChanges = (itemId: string, updatedSeo: { title: string; metaDescription: string; slug: string }, updatedContent: string) => {
        const item = items.find(i => i.id === itemId);
        if (item && item.generatedContent) {
            const updatedGeneratedContent = {
                ...item.generatedContent,
                title: updatedSeo.title,
                metaDescription: updatedSeo.metaDescription,
                slug: extractSlugFromUrl(updatedSeo.slug),
                content: updatedContent,
            };

            updatedGeneratedContent.jsonLdSchema = generateFullSchema(
                updatedGeneratedContent, wpConfig, siteInfo, [], geoTargeting
            );
            
            dispatch({ type: 'SET_CONTENT', payload: { id: itemId, content: updatedGeneratedContent } });
        }
    };
    
    const onPublishSuccess = (originalUrl: string) => {
        setExistingPages(prev => prev.map(page =>
            page.id === originalUrl
                ? { ...page, publishedState: 'updated', updatePriority: 'Healthy', lastMod: new Date().toISOString() }
                : page
        ));
    };

    return (
        <div className={`app-container ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
            <div className="toast-container">
                {toasts.map(toast => (
                    <div key={toast.id} className={`toast ${toast.type}`}>
                        {toast.message}
                    </div>
                ))}
            </div>

            <aside className="sidebar">
                 <div className="sidebar-header">
                     <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer" className="logo-link">
                        <img src="https://affiliatemarketingforsuccess.com/wp-content/uploads/2023/03/cropped-Affiliate-Marketing-for-Success-Logo-Edited.png?lm=6666FEE0" alt="Logo" className="sidebar-logo" />
                     </a>
                     <h1 className="sidebar-title">WP Content Optimizer Pro</h1>
                </div>
                 <button className="sidebar-toggle" onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)} aria-label="Toggle sidebar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                </button>
                <SidebarNav activeView={activeView} onNavClick={setActiveView} />
            </aside>
            <main className="main-content">
                {activeView === 'setup' && <SetupView {...{ apiKeys, apiKeyStatus, handleApiKeyChange, editingApiKey, setEditingApiKey, selectedModel, setSelectedModel, selectedGroqModel, setSelectedGroqModel, openrouterModels, handleOpenrouterModelsChange, useGoogleSearch, setUseGoogleSearch, wpConfig, setWpConfig, wpPassword, setWpPassword, siteInfo, setSiteInfo, geoTargeting, setGeoTargeting }} />}
                {activeView === 'strategy' && <StrategyView {...{ contentMode, setContentMode, topic, setTopic, primaryKeywords, setPrimaryKeywords, sitemapUrl, setSitemapUrl, isCrawling, crawlMessage, existingPages, hubSearchFilter, setHubSearchFilter, hubStatusFilter, setHubStatusFilter, hubSortConfig, handleHubSort, isAnalyzingHealth, healthAnalysisProgress, selectedHubPages, handleToggleHubPageSelect, handleToggleHubPageSelectAll, handleAnalyzeSelectedPages, analyzableForRewrite, handleRewriteSelected, handleOptimizeLinksSelected, setViewingAnalysis, handleCrawlSitemap, isGenerating, handleGenerateClusterPlan, handleGenerateMultipleFromKeywords, imagePrompt, setImagePrompt, numImages, setNumImages, aspectRatio, setAspectRatio, isGeneratingImages, imageGenerationError, generatedImages, handleGenerateImages, handleDownloadImage, addToast, filteredAndSortedHubPages, keywordTopic, setKeywordTopic, handleFindKeywords, isFindingKeywords, keywordStatusText, keywordResults, handleAddKeywordsToQueue }} />}
                {activeView === 'review' && <ReviewView {...{ filter, setFilter, isGenerating, selectedItems, handleGenerateSelected, items, handleToggleSelect, handleToggleSelectAll, filteredAndSortedItems, handleSort, setSelectedItemForReview, handleGenerateSingle, handleStopGeneration, generationProgress, setIsBulkPublishModalOpen }} />}

                {selectedItemForReview && (
                    <ReviewModal
                        item={selectedItemForReview}
                        onClose={() => setSelectedItemForReview(null)}
                        onSaveChanges={handleSaveChanges}
                        wpConfig={wpConfig}
                        wpPassword={wpPassword}
                        onPublishSuccess={onPublishSuccess}
                        publishItem={publishItem}
                        callAI={callAI}
                        geoTargeting={geoTargeting}
                        addToast={addToast}
                    />
                )}

                 {isBulkPublishModalOpen && (
                    <BulkPublishModal
                        items={items.filter(i => i.status === 'done' && selectedItems.has(i.id))}
                        onClose={() => setIsBulkPublishModalOpen(false)}
                        publishItem={publishItem}
                        wpPassword={wpPassword}
                        onPublishSuccess={onPublishSuccess}
                    />
                )}

                 {viewingAnalysis && (
                    <AnalysisModal
                        page={viewingAnalysis}
                        onClose={() => setViewingAnalysis(null)}
                        onPlanRewrite={handlePlanRewrite}
                    />
                )}

                <AppFooter />
            </main>
        </div>
    );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);