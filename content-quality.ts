/**
 * SOTA Content Quality & E-E-A-T Scoring System
 * Professional-grade content analysis and multi-model consensus
 */

export interface EEATScore {
    experience: number;
    expertise: number;
    authority: number;
    trust: number;
    overall: number;
    details: {
        experienceIndicators: string[];
        expertiseSignals: string[];
        authorityMarkers: string[];
        trustSignals: string[];
    };
}

export interface ContentQualityMetrics {
    wordCount: number;
    readabilityScore: number;
    humanWritingScore: number;
    eeatScore: EEATScore;
    citationCount: number;
    internalLinkCount: number;
    mediaCount: {
        images: number;
        videos: number;
        tables: number;
        lists: number;
    };
    keywordDensity: number;
    passesQualityGate: boolean;
    failures: string[];
}

/**
 * Calculate comprehensive E-E-A-T score
 * Minimum score required: 85/100
 */
export function calculateEEATScore(content: string, metadata: any): EEATScore {
    const indicators = {
        experienceIndicators: [] as string[],
        expertiseSignals: [] as string[],
        authorityMarkers: [] as string[],
        trustSignals: [] as string[]
    };

    let experienceScore = 0;
    let expertiseScore = 0;
    let authorityScore = 0;
    let trustScore = 0;

    const lowerContent = content.toLowerCase();

    // EXPERIENCE INDICATORS (0-30 points)
    const experiencePatterns = [
        { pattern: /in my experience|from my experience|i've found|personally|i've tested/gi, points: 5, desc: 'Personal experience mentioned' },
        { pattern: /case study|real[- ]world example|actual results/gi, points: 4, desc: 'Case studies or real examples' },
        { pattern: /\d+[- ]years? (?:of )?experience/gi, points: 3, desc: 'Years of experience stated' },
        { pattern: /hands[- ]on|practical|worked with|implemented/gi, points: 2, desc: 'Hands-on experience' }
    ];

    experiencePatterns.forEach(({ pattern, points, desc }) => {
        const matches = lowerContent.match(pattern);
        if (matches && matches.length > 0) {
            const score = Math.min(points * matches.length, points * 2);
            experienceScore += score;
            indicators.experienceIndicators.push(`${desc} (${matches.length}x)`);
        }
    });

    // EXPERTISE INDICATORS (0-30 points)
    const expertisePatterns = [
        { pattern: /\b(?:phd|ph\.d\.|doctorate|professor|dr\.|certified|accredited)\b/gi, points: 6, desc: 'Professional credentials' },
        { pattern: /\b(?:research shows|studies indicate|according to research|peer[- ]reviewed)\b/gi, points: 4, desc: 'Research-backed claims' },
        { pattern: /technical|methodology|algorithm|framework|analysis/gi, points: 2, desc: 'Technical terminology' },
        { pattern: /\b(?:expert|specialist|authority|professional)\b/gi, points: 2, desc: 'Expertise language' }
    ];

    expertisePatterns.forEach(({ pattern, points, desc }) => {
        const matches = lowerContent.match(pattern);
        if (matches && matches.length > 0) {
            const score = Math.min(points * Math.min(matches.length, 3), points * 2);
            expertiseScore += score;
            indicators.expertiseSignals.push(`${desc} (${matches.length}x)`);
        }
    });

    // AUTHORITY INDICATORS (0-25 points)
    const citationMatches = content.match(/\[\d+\]/g);
    const citationCount = citationMatches ? citationMatches.length : 0;
    if (citationCount >= 12) {
        authorityScore += 10;
        indicators.authorityMarkers.push(`${citationCount} citations (excellent)`);
    } else if (citationCount >= 8) {
        authorityScore += 7;
        indicators.authorityMarkers.push(`${citationCount} citations (good)`);
    } else if (citationCount >= 5) {
        authorityScore += 4;
        indicators.authorityMarkers.push(`${citationCount} citations (adequate)`);
    }

    const authorityPatterns = [
        { pattern: /published in|featured in|recognized by/gi, points: 5, desc: 'External recognition' },
        { pattern: /award[- ]winning|industry[- ]leading|top[- ]rated/gi, points: 3, desc: 'Achievement mentions' },
        { pattern: /partnered with|collaborated with|endorsed by/gi, points: 3, desc: 'Partnerships/endorsements' }
    ];

    authorityPatterns.forEach(({ pattern, points, desc }) => {
        const matches = lowerContent.match(pattern);
        if (matches && matches.length > 0) {
            authorityScore += Math.min(points, points);
            indicators.authorityMarkers.push(desc);
        }
    });

    // TRUST INDICATORS (0-15 points)
    const trustPatterns = [
        { pattern: /updated|revised|current|latest|2025/gi, points: 3, desc: 'Freshness signals' },
        { pattern: /fact[- ]checked|verified|accurate|reliable/gi, points: 4, desc: 'Verification language' },
        { pattern: /however|although|on the other hand|some argue/gi, points: 3, desc: 'Balanced perspective' },
        { pattern: /disclaimer|important note|be aware|caution/gi, points: 2, desc: 'Transparency/disclaimers' },
        { pattern: /sources?:|references?:|citations?:/gi, points: 3, desc: 'Source attribution' }
    ];

    trustPatterns.forEach(({ pattern, points, desc }) => {
        const matches = lowerContent.match(pattern);
        if (matches && matches.length > 0) {
            trustScore += Math.min(points, points);
            indicators.trustSignals.push(desc);
        }
    });

    // Normalize scores to 0-100 scale
    experienceScore = Math.min(experienceScore, 30);
    expertiseScore = Math.min(expertiseScore, 30);
    authorityScore = Math.min(authorityScore, 25);
    trustScore = Math.min(trustScore, 15);

    const overall = experienceScore + expertiseScore + authorityScore + trustScore;

    return {
        experience: Math.round((experienceScore / 30) * 100),
        expertise: Math.round((expertiseScore / 30) * 100),
        authority: Math.round((authorityScore / 25) * 100),
        trust: Math.round((trustScore / 15) * 100),
        overall: Math.round(overall),
        details: indicators
    };
}

/**
 * Comprehensive content quality analysis
 * Returns detailed metrics and quality gate pass/fail
 */
export function analyzeContentQuality(
    content: string,
    title: string,
    primaryKeyword: string,
    metadata?: any
): ContentQualityMetrics {
    const failures: string[] = [];

    // Word Count
    const textOnly = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = textOnly.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    if (wordCount < 2500) {
        failures.push(`Word count too low: ${wordCount} (minimum: 2500)`);
    }

    // Readability Score (Flesch-Kincaid approximation)
    const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
    const avgWordsPerSentence = sentences.length > 0 ? words.length / sentences.length : 0;
    const syllableCount = words.reduce((sum, word) => sum + estimateSyllables(word), 0);
    const avgSyllablesPerWord = words.length > 0 ? syllableCount / words.length : 0;

    const readabilityScore = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

    if (readabilityScore < 80) {
        failures.push(`Readability score too low: ${Math.round(readabilityScore)} (minimum: 80)`);
    }

    // Human Writing Score
    const humanWritingScore = checkHumanWritingScore(content);

    if (humanWritingScore < 80) {
        failures.push(`Human writing score too low: ${humanWritingScore} (minimum: 80)`);
    }

    // E-E-A-T Score
    const eeatScore = calculateEEATScore(content, metadata);

    if (eeatScore.overall < 85) {
        failures.push(`E-E-A-T score too low: ${eeatScore.overall} (minimum: 85)`);
    }

    // Citation Count
    const citationMatches = content.match(/\[\d+\]/g);
    const citationCount = citationMatches ? citationMatches.length : 0;

    if (citationCount < 12) {
        failures.push(`Insufficient citations: ${citationCount} (minimum: 12)`);
    }

    // Internal Links
    const internalLinkMatches = content.match(/\[INTERNAL_LINK/g);
    const internalLinkCount = internalLinkMatches ? internalLinkMatches.length : 0;

    if (internalLinkCount < 8) {
        failures.push(`Insufficient internal links: ${internalLinkCount} (minimum: 8)`);
    }

    // Media Count
    const imageCount = (content.match(/<img/g) || []).length + (content.match(/\[IMAGE_\d+_PLACEHOLDER\]/g) || []).length;
    const videoCount = (content.match(/<iframe.*youtube/g) || []).length;
    const tableCount = (content.match(/<table/g) || []).length;
    const listCount = (content.match(/<ul|<ol/g) || []).length;

    const mediaCount = {
        images: imageCount,
        videos: videoCount,
        tables: tableCount,
        lists: listCount
    };

    if (tableCount < 3) {
        failures.push(`Insufficient tables: ${tableCount} (minimum: 3)`);
    }

    if (videoCount < 2) {
        failures.push(`Insufficient videos: ${videoCount} (minimum: 2)`);
    }

    // Keyword Density
    const keywordMatches = textOnly.toLowerCase().match(new RegExp(primaryKeyword.toLowerCase(), 'g'));
    const keywordCount = keywordMatches ? keywordMatches.length : 0;
    const keywordDensity = (keywordCount / words.length) * 100;

    if (keywordDensity < 0.5 || keywordDensity > 2.5) {
        failures.push(`Keyword density out of range: ${keywordDensity.toFixed(2)}% (optimal: 0.5-2.5%)`);
    }

    // Check if primary keyword is in first 100 words
    const first100Words = words.slice(0, 100).join(' ').toLowerCase();
    if (!first100Words.includes(primaryKeyword.toLowerCase())) {
        failures.push('Primary keyword not found in first 100 words');
    }

    return {
        wordCount,
        readabilityScore: Math.round(readabilityScore),
        humanWritingScore,
        eeatScore,
        citationCount,
        internalLinkCount,
        mediaCount,
        keywordDensity: parseFloat(keywordDensity.toFixed(2)),
        passesQualityGate: failures.length === 0,
        failures
    };
}

/**
 * Estimate syllable count for readability calculation
 */
function estimateSyllables(word: string): number {
    word = word.toLowerCase();
    if (word.length <= 3) return 1;

    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');

    const syllables = word.match(/[aeiouy]{1,2}/g);
    return syllables ? syllables.length : 1;
}

/**
 * Check for AI-sounding phrases and calculate human writing score
 */
function checkHumanWritingScore(content: string): number {
    const aiPhrases = [
        'delve into', 'in today\'s digital landscape', 'revolutionize', 'game-changer',
        'unlock', 'leverage', 'robust', 'seamless', 'cutting-edge', 'elevate', 'empower',
        'it\'s important to note', 'it\'s worth mentioning', 'needless to say',
        'in conclusion', 'to summarize', 'in summary', 'holistic', 'paradigm shift',
        'utilize', 'commence', 'endeavor', 'facilitate', 'implement', 'demonstrate',
        'landscape', 'realm', 'sphere', 'domain', 'ecosystem',
        'navigate', 'embark', 'journey', 'transform', 'transition',
        'comprehensive guide', 'ultimate guide', 'dive deep'
    ];

    let aiScore = 0;
    const lowerContent = content.toLowerCase();

    aiPhrases.forEach(phrase => {
        const count = (lowerContent.match(new RegExp(phrase, 'g')) || []).length;
        if (count > 0) {
            aiScore += (count * 10);
        }
    });

    const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length > 0) {
        const avgLength = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length;
        if (avgLength > 25) {
            aiScore += 15;
        }
    }

    return Math.max(0, 100 - aiScore);
}

/**
 * Multi-model consensus for critical content decisions
 * Synthesizes output from multiple AI models for highest quality
 */
export interface ModelOutput {
    model: string;
    output: string;
    confidence?: number;
}

export async function synthesizeBestOutput(
    outputs: ModelOutput[],
    synthesisPrompt: string,
    synthesizeFunc: (prompt: string) => Promise<string>
): Promise<string> {
    if (outputs.length === 1) {
        return outputs[0].output;
    }

    const combinedPrompt = `
${synthesisPrompt}

You have received ${outputs.length} different versions of the same content from different AI models.
Your task is to synthesize the BEST possible version by:
1. Identifying the strongest elements from each version
2. Combining them into a superior final output
3. Eliminating redundancy and weaknesses
4. Ensuring consistency and coherence

**Model Outputs:**

${outputs.map((o, i) => `
=== VERSION ${i + 1} (from ${o.model}) ===
${o.output}
`).join('\n')}

**Instructions:**
- Take the best ideas, phrasing, and structure from ALL versions
- Create a version that is better than any individual input
- Maintain the same format and structure expected
- Do not add commentary or explanations

Generate the synthesized best version now:
`;

    return await synthesizeFunc(combinedPrompt);
}
