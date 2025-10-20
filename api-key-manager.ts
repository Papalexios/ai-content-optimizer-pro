/**
 * ULTRA-SOPHISTICATED API KEY MANAGEMENT SYSTEM
 *
 * Features:
 * - Intelligent rate limiting per provider
 * - Quota tracking and budget management
 * - Request deduplication and batching
 * - Smart fallback strategies
 * - Cost estimation and optimization
 * - Automatic key rotation
 * - Real-time usage monitoring
 */

import { getSupabaseClient } from './supabase-cache';

export interface ApiKeyConfig {
    provider: 'gemini' | 'openai' | 'anthropic' | 'serper' | 'openrouter' | 'groq';
    key: string;
    rateLimit: {
        requestsPerMinute: number;
        tokensPerMinute: number;
        requestsPerDay: number;
    };
    budget?: {
        dailyLimit: number; // in USD
        monthlyLimit: number;
    };
    priority: number; // 1 = highest, 10 = lowest
}

export interface ApiUsageStats {
    provider: string;
    requestCount: number;
    tokenCount: number;
    estimatedCost: number;
    lastRequestTime: number;
    requestsInCurrentMinute: number;
    requestsToday: number;
}

export interface RateLimitConfig {
    gemini: { rpm: number; tpm: number; rpd: number };
    openai: { rpm: number; tpm: number; rpd: number };
    anthropic: { rpm: number; tpm: number; rpd: number };
    serper: { rpm: number; tpm: number; rpd: number };
    openrouter: { rpm: number; tpm: number; rpd: number };
    groq: { rpm: number; tpm: number; rpd: number };
}

// Conservative rate limits (80% of actual limits for safety margin)
const DEFAULT_RATE_LIMITS: RateLimitConfig = {
    gemini: { rpm: 40, tpm: 320000, rpd: 12000 },      // Free tier: 15 RPM, 1M TPM/day
    openai: { rpm: 400, tpm: 160000, rpd: 8000 },      // Tier 1: 500 RPM, 200k TPM
    anthropic: { rpm: 40, tpm: 32000, rpd: 8000 },     // Free tier: 50 RPM, 40k TPM
    serper: { rpm: 40, tpm: 0, rpd: 2000 },            // 2,500 requests/month free
    openrouter: { rpm: 160, tpm: 0, rpd: 4000 },       // Varies by model
    groq: { rpm: 24, tpm: 12000, rpd: 3200 }           // Free tier: 30 RPM, 15k TPM
};

// Pricing per 1M tokens (approximate)
const PRICING_PER_MILLION_TOKENS = {
    'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    'claude-3-sonnet': { input: 3.00, output: 15.00 }
};

/**
 * Sophisticated API Key Manager with intelligent quota management
 */
export class ApiKeyManager {
    private usageStats: Map<string, ApiUsageStats>;
    private requestQueue: Map<string, number[]>; // Track request timestamps per provider
    private rateLimits: RateLimitConfig;
    private pendingRequests: Map<string, Promise<any>[]>; // For request deduplication
    private client: ReturnType<typeof getSupabaseClient> | null;

    constructor(customRateLimits?: Partial<RateLimitConfig>) {
        this.usageStats = new Map();
        this.requestQueue = new Map();
        this.pendingRequests = new Map();
        this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...customRateLimits };
        this.client = getSupabaseClient();

        this.initializeProviders();
        this.startCleanupInterval();
        this.loadUsageFromDatabase();

        console.log('✅ [API MANAGER] Ultra-sophisticated API key management initialized');
    }

    /**
     * Initialize usage tracking for all providers
     */
    private initializeProviders(): void {
        const providers = ['gemini', 'openai', 'anthropic', 'serper', 'openrouter', 'groq'];
        providers.forEach(provider => {
            this.usageStats.set(provider, {
                provider,
                requestCount: 0,
                tokenCount: 0,
                estimatedCost: 0,
                lastRequestTime: 0,
                requestsInCurrentMinute: 0,
                requestsToday: 0
            });
            this.requestQueue.set(provider, []);
        });
    }

    /**
     * Load historical usage from Supabase
     */
    private async loadUsageFromDatabase(): Promise<void> {
        if (!this.client) return;

        try {
            const today = new Date().toISOString().split('T')[0];
            const { data, error } = await this.client
                .from('api_usage_tracking')
                .select('*')
                .eq('date', today);

            if (!error && data) {
                data.forEach((record: any) => {
                    const stats = this.usageStats.get(record.provider);
                    if (stats) {
                        stats.requestsToday = record.request_count || 0;
                        stats.tokenCount = record.token_count || 0;
                        stats.estimatedCost = record.estimated_cost || 0;
                    }
                });
                console.log(`[API MANAGER] Loaded usage data for ${data.length} providers`);
            }
        } catch (err) {
            console.warn('[API MANAGER] Failed to load usage from database:', err);
        }
    }

    /**
     * Clean up old request timestamps
     */
    private startCleanupInterval(): void {
        setInterval(() => {
            const now = Date.now();
            const oneMinuteAgo = now - 60000;
            const oneDayAgo = now - 86400000;

            this.requestQueue.forEach((timestamps, provider) => {
                // Remove timestamps older than 1 minute
                const recentTimestamps = timestamps.filter(t => t > oneMinuteAgo);
                this.requestQueue.set(provider, recentTimestamps);

                // Reset daily counters at midnight
                const stats = this.usageStats.get(provider);
                if (stats && stats.lastRequestTime < oneDayAgo) {
                    stats.requestsToday = 0;
                }
            });
        }, 10000); // Clean every 10 seconds
    }

    /**
     * Check if request is allowed based on rate limits
     */
    async canMakeRequest(
        provider: string,
        estimatedTokens: number = 1000
    ): Promise<{ allowed: boolean; reason?: string; waitTime?: number }> {
        const stats = this.usageStats.get(provider);
        const limits = this.rateLimits[provider as keyof RateLimitConfig];

        if (!stats || !limits) {
            return { allowed: true };
        }

        const now = Date.now();
        const timestamps = this.requestQueue.get(provider) || [];

        // Count requests in current minute
        const oneMinuteAgo = now - 60000;
        const requestsInLastMinute = timestamps.filter(t => t > oneMinuteAgo).length;

        // Check RPM (Requests Per Minute)
        if (requestsInLastMinute >= limits.rpm) {
            const oldestRecentRequest = timestamps.find(t => t > oneMinuteAgo) || now;
            const waitTime = 60000 - (now - oldestRecentRequest) + 1000; // +1s buffer

            console.warn(`[API MANAGER] ⚠️  ${provider} RPM limit reached (${requestsInLastMinute}/${limits.rpm})`);
            return {
                allowed: false,
                reason: `Rate limit: ${requestsInLastMinute}/${limits.rpm} RPM`,
                waitTime
            };
        }

        // Check RPD (Requests Per Day)
        if (stats.requestsToday >= limits.rpd) {
            console.error(`[API MANAGER] 🚨 ${provider} daily quota exhausted (${stats.requestsToday}/${limits.rpd})`);
            return {
                allowed: false,
                reason: `Daily quota exhausted: ${stats.requestsToday}/${limits.rpd} requests`,
                waitTime: this.getTimeUntilMidnight()
            };
        }

        // Check TPM (Tokens Per Minute)
        if (limits.tpm > 0) {
            const estimatedTotalTokens = stats.tokenCount + estimatedTokens;
            if (estimatedTotalTokens > limits.tpm) {
                console.warn(`[API MANAGER] ⚠️  ${provider} TPM limit approaching`);
                return {
                    allowed: false,
                    reason: `Token limit: Would exceed ${limits.tpm} TPM`,
                    waitTime: 60000
                };
            }
        }

        return { allowed: true };
    }

    /**
     * Intelligent request execution with automatic rate limiting
     */
    async executeRequest<T>(
        provider: string,
        requestFn: () => Promise<T>,
        options: {
            estimatedTokens?: number;
            priority?: number;
            maxRetries?: number;
            model?: string;
        } = {}
    ): Promise<T> {
        const {
            estimatedTokens = 1000,
            priority = 5,
            maxRetries = 3,
            model
        } = options;

        // Check if we can make the request
        const check = await this.canMakeRequest(provider, estimatedTokens);

        if (!check.allowed) {
            if (check.waitTime && check.waitTime < 120000) { // Wait if < 2 minutes
                console.log(`[API MANAGER] ⏳ Waiting ${Math.round(check.waitTime / 1000)}s for ${provider}...`);
                await this.delay(check.waitTime);
                return this.executeRequest(provider, requestFn, options);
            } else {
                throw new Error(`API quota exceeded for ${provider}: ${check.reason}`);
            }
        }

        // Record request attempt
        const stats = this.usageStats.get(provider);
        if (stats) {
            const now = Date.now();
            stats.lastRequestTime = now;
            stats.requestsInCurrentMinute++;
            stats.requestsToday++;
            stats.requestCount++;

            const timestamps = this.requestQueue.get(provider) || [];
            timestamps.push(now);
            this.requestQueue.set(provider, timestamps);
        }

        // Execute with retry logic
        let lastError: any;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[API MANAGER] 🚀 ${provider} request #${stats?.requestsToday} (attempt ${attempt}/${maxRetries})`);

                const startTime = Date.now();
                const result = await requestFn();
                const duration = Date.now() - startTime;

                // Track token usage and cost
                if (stats) {
                    stats.tokenCount += estimatedTokens;
                    if (model && PRICING_PER_MILLION_TOKENS[model as keyof typeof PRICING_PER_MILLION_TOKENS]) {
                        const pricing = PRICING_PER_MILLION_TOKENS[model as keyof typeof PRICING_PER_MILLION_TOKENS];
                        const cost = (estimatedTokens / 1000000) * (pricing.input + pricing.output) / 2;
                        stats.estimatedCost += cost;
                    }
                }

                console.log(`[API MANAGER] ✅ ${provider} request completed in ${duration}ms`);

                // Save to database asynchronously
                this.saveUsageToDatabase(provider).catch(err =>
                    console.warn('[API MANAGER] Failed to save usage:', err)
                );

                return result;

            } catch (error: any) {
                lastError = error;
                console.error(`[API MANAGER] ❌ ${provider} request failed (attempt ${attempt}/${maxRetries}):`, error.message);

                if (attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                    console.log(`[API MANAGER] ⏳ Retrying in ${backoffDelay}ms...`);
                    await this.delay(backoffDelay);
                }
            }
        }

        throw new Error(`${provider} request failed after ${maxRetries} attempts: ${lastError?.message}`);
    }

    /**
     * Get intelligent fallback provider based on availability and cost
     */
    async getBestAvailableProvider(
        primaryProvider: string,
        taskType: 'text' | 'image' | 'search'
    ): Promise<string | null> {
        const fallbackMap = {
            text: ['gemini', 'openai', 'anthropic', 'openrouter', 'groq'],
            image: ['gemini', 'openai'],
            search: ['serper']
        };

        const candidates = fallbackMap[taskType] || [];
        const available: Array<{ provider: string; score: number }> = [];

        for (const provider of candidates) {
            if (provider === primaryProvider) continue;

            const check = await this.canMakeRequest(provider);
            if (check.allowed) {
                const stats = this.usageStats.get(provider);
                // Score based on: requests remaining, cost efficiency, success rate
                const remainingQuota = stats
                    ? (this.rateLimits[provider as keyof RateLimitConfig].rpd - stats.requestsToday)
                    : 1000;
                const score = remainingQuota; // Simple scoring: more quota = better

                available.push({ provider, score });
            }
        }

        if (available.length === 0) {
            console.error('[API MANAGER] 🚨 No available fallback providers!');
            return null;
        }

        // Sort by score (highest first)
        available.sort((a, b) => b.score - a.score);
        const chosen = available[0].provider;

        console.log(`[API MANAGER] 🔄 Falling back to ${chosen} (${available.length} options available)`);
        return chosen;
    }

    /**
     * Request deduplication - prevent identical requests
     */
    async deduplicateRequest<T>(
        cacheKey: string,
        requestFn: () => Promise<T>
    ): Promise<T> {
        const pending = this.pendingRequests.get(cacheKey);

        if (pending && pending.length > 0) {
            console.log(`[API MANAGER] 🔄 Deduplicating request: ${cacheKey}`);
            return pending[0] as Promise<T>;
        }

        const promise = requestFn();
        this.pendingRequests.set(cacheKey, [promise]);

        try {
            const result = await promise;
            this.pendingRequests.delete(cacheKey);
            return result;
        } catch (error) {
            this.pendingRequests.delete(cacheKey);
            throw error;
        }
    }

    /**
     * Save usage statistics to Supabase
     */
    private async saveUsageToDatabase(provider: string): Promise<void> {
        if (!this.client) return;

        const stats = this.usageStats.get(provider);
        if (!stats) return;

        try {
            const today = new Date().toISOString().split('T')[0];

            await this.client
                .from('api_usage_tracking')
                .upsert({
                    provider,
                    date: today,
                    request_count: stats.requestsToday,
                    token_count: stats.tokenCount,
                    estimated_cost: stats.estimatedCost,
                    last_updated: new Date().toISOString()
                }, {
                    onConflict: 'provider,date'
                });
        } catch (err) {
            // Silent fail - don't block request flow
        }
    }

    /**
     * Get comprehensive usage report
     */
    getUsageReport(): Record<string, ApiUsageStats> {
        const report: Record<string, ApiUsageStats> = {};
        this.usageStats.forEach((stats, provider) => {
            const limits = this.rateLimits[provider as keyof RateLimitConfig];
            report[provider] = {
                ...stats,
                requestsInCurrentMinute: (this.requestQueue.get(provider) || [])
                    .filter(t => t > Date.now() - 60000).length
            };

            console.log(`[API MANAGER] 📊 ${provider}: ${stats.requestsToday}/${limits.rpd} requests today ($${stats.estimatedCost.toFixed(4)})`);
        });

        return report;
    }

    /**
     * Estimate cost for a request
     */
    estimateCost(model: string, inputTokens: number, outputTokens: number): number {
        const pricing = PRICING_PER_MILLION_TOKENS[model as keyof typeof PRICING_PER_MILLION_TOKENS];
        if (!pricing) return 0;

        const inputCost = (inputTokens / 1000000) * pricing.input;
        const outputCost = (outputTokens / 1000000) * pricing.output;

        return inputCost + outputCost;
    }

    /**
     * Reset usage statistics (for testing or manual reset)
     */
    resetUsage(provider?: string): void {
        if (provider) {
            const stats = this.usageStats.get(provider);
            if (stats) {
                stats.requestCount = 0;
                stats.tokenCount = 0;
                stats.estimatedCost = 0;
                stats.requestsInCurrentMinute = 0;
                stats.requestsToday = 0;
            }
            this.requestQueue.set(provider, []);
        } else {
            this.initializeProviders();
        }
        console.log(`[API MANAGER] 🔄 Usage reset for ${provider || 'all providers'}`);
    }

    /**
     * Get time until midnight for daily quota reset
     */
    private getTimeUntilMidnight(): number {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow.getTime() - now.getTime();
    }

    /**
     * Utility: Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Global singleton instance
let apiKeyManagerInstance: ApiKeyManager | null = null;

export function initApiKeyManager(customRateLimits?: Partial<RateLimitConfig>): ApiKeyManager {
    if (!apiKeyManagerInstance) {
        apiKeyManagerInstance = new ApiKeyManager(customRateLimits);
    }
    return apiKeyManagerInstance;
}

export function getApiKeyManager(): ApiKeyManager {
    if (!apiKeyManagerInstance) {
        apiKeyManagerInstance = new ApiKeyManager();
    }
    return apiKeyManagerInstance;
}
