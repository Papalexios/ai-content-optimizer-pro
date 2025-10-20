import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseClient: ReturnType<typeof createClient> | null = null;

export const initSupabase = () => {
    if (!supabaseClient && SUPABASE_URL && SUPABASE_ANON_KEY) {
        supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabaseClient;
};

export const getSupabaseClient = () => {
    if (!supabaseClient) {
        initSupabase();
    }
    return supabaseClient;
};

/**
 * Premium Supabase-backed cache with 24-hour TTL
 * Provides persistent caching across sessions for maximum efficiency
 */
export class SupabaseCache {
    private client: ReturnType<typeof createClient> | null;
    private TTL = 86400000; // 24 hours in milliseconds
    private enabled = false;

    constructor() {
        this.client = getSupabaseClient();
        this.enabled = !!this.client;

        if (this.enabled) {
            console.log('✅ Supabase cache initialized - 24h TTL active');
            this.scheduleCleanup();
        } else {
            console.warn('⚠️  Supabase not configured - using in-memory cache only');
        }
    }

    /**
     * Generate a deterministic cache key from parameters
     */
    private generateCacheKey(type: string, params: any): string {
        const normalized = JSON.stringify(params, Object.keys(params).sort());
        return `${type}:${this.hashString(normalized)}`;
    }

    /**
     * Simple hash function for cache keys
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Get cached data with automatic expiry handling
     */
    async get(type: string, params: any): Promise<any | null> {
        if (!this.enabled || !this.client) {
            return null;
        }

        const cacheKey = this.generateCacheKey(type, params);

        try {
            const { data, error } = await this.client
                .from('content_cache')
                .select('content, expires_at, hit_count')
                .eq('cache_key', cacheKey)
                .single();

            if (error || !data) {
                console.log(`[Cache] MISS for ${type}`);
                return null;
            }

            // Check expiry
            if (new Date(data.expires_at) < new Date()) {
                console.log(`[Cache] EXPIRED for ${type}`);
                await this.delete(cacheKey);
                return null;
            }

            // Increment hit count
            await this.client
                .from('content_cache')
                .update({ hit_count: data.hit_count + 1 })
                .eq('cache_key', cacheKey);

            console.log(`[Cache] HIT for ${type} (hits: ${data.hit_count + 1})`);
            return data.content;
        } catch (err) {
            console.error('[Cache] Error reading from cache:', err);
            return null;
        }
    }

    /**
     * Store data in cache with automatic expiry
     */
    async set(type: string, params: any, content: any, topic?: string): Promise<void> {
        if (!this.enabled || !this.client) {
            return;
        }

        const cacheKey = this.generateCacheKey(type, params);
        const expiresAt = new Date(Date.now() + this.TTL);

        try {
            const { error } = await this.client
                .from('content_cache')
                .upsert({
                    cache_key: cacheKey,
                    cache_type: type,
                    content,
                    topic,
                    expires_at: expiresAt.toISOString(),
                    hit_count: 0
                }, {
                    onConflict: 'cache_key'
                });

            if (error) {
                console.error('[Cache] Error writing to cache:', error);
            } else {
                console.log(`[Cache] STORED ${type} (expires: ${expiresAt.toLocaleString()})`);
            }
        } catch (err) {
            console.error('[Cache] Error writing to cache:', err);
        }
    }

    /**
     * Delete specific cache entry
     */
    private async delete(cacheKey: string): Promise<void> {
        if (!this.enabled || !this.client) {
            return;
        }

        try {
            await this.client
                .from('content_cache')
                .delete()
                .eq('cache_key', cacheKey);
        } catch (err) {
            console.error('[Cache] Error deleting cache entry:', err);
        }
    }

    /**
     * Clear all cache entries of a specific type
     */
    async clearType(type: string): Promise<void> {
        if (!this.enabled || !this.client) {
            return;
        }

        try {
            const { error } = await this.client
                .from('content_cache')
                .delete()
                .eq('cache_type', type);

            if (error) {
                console.error(`[Cache] Error clearing ${type} cache:`, error);
            } else {
                console.log(`[Cache] Cleared all ${type} cache entries`);
            }
        } catch (err) {
            console.error('[Cache] Error clearing cache:', err);
        }
    }

    /**
     * Get cache statistics
     */
    async getStats(): Promise<any> {
        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const { data, error } = await this.client
                .from('content_cache')
                .select('cache_type, hit_count, created_at');

            if (error) {
                console.error('[Cache] Error getting stats:', error);
                return null;
            }

            const stats = data?.reduce((acc: any, entry: any) => {
                if (!acc[entry.cache_type]) {
                    acc[entry.cache_type] = { count: 0, totalHits: 0 };
                }
                acc[entry.cache_type].count++;
                acc[entry.cache_type].totalHits += entry.hit_count;
                return acc;
            }, {});

            return stats;
        } catch (err) {
            console.error('[Cache] Error getting stats:', err);
            return null;
        }
    }

    /**
     * Schedule periodic cleanup of expired entries
     */
    private scheduleCleanup(): void {
        if (!this.enabled || !this.client) {
            return;
        }

        // Clean expired cache every hour
        setInterval(async () => {
            try {
                const { error } = await this.client!
                    .from('content_cache')
                    .delete()
                    .lt('expires_at', new Date().toISOString());

                if (!error) {
                    console.log('[Cache] Automatic cleanup completed');
                }
            } catch (err) {
                console.error('[Cache] Cleanup error:', err);
            }
        }, 3600000); // 1 hour
    }
}

/**
 * Store generated article in database for analytics and reuse
 */
export async function saveGeneratedArticle(article: {
    title: string;
    slug: string;
    content: string;
    metaDescription: string;
    primaryKeyword: string;
    semanticKeywords: string[];
    wordCount: number;
    eeatScore: number;
    readabilityScore: number;
    humanWritingScore: number;
    metadata?: any;
}): Promise<string | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
        const { data, error } = await client
            .from('generated_articles')
            .insert({
                title: article.title,
                slug: article.slug,
                content: article.content,
                meta_description: article.metaDescription,
                primary_keyword: article.primaryKeyword,
                semantic_keywords: article.semanticKeywords,
                word_count: article.wordCount,
                eeat_score: article.eeatScore,
                readability_score: article.readabilityScore,
                human_writing_score: article.humanWritingScore,
                generation_metadata: article.metadata || {}
            })
            .select('id')
            .single();

        if (error) {
            console.error('[DB] Error saving article:', error);
            return null;
        }

        console.log(`[DB] Article saved: ${article.title} (ID: ${data.id})`);
        return data.id;
    } catch (err) {
        console.error('[DB] Error saving article:', err);
        return null;
    }
}

/**
 * Save competitor analysis data
 */
export async function saveCompetitorAnalysis(analysis: {
    keyword: string;
    serpPosition: number;
    competitorUrl: string;
    wordCount: number;
    topicsCovered: string[];
    mediaCount: any;
    readabilityScore: number;
}): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    try {
        await client.from('competitor_analysis').insert({
            keyword: analysis.keyword,
            serp_position: analysis.serpPosition,
            competitor_url: analysis.competitorUrl,
            word_count: analysis.wordCount,
            topics_covered: analysis.topicsCovered,
            media_count: analysis.mediaCount,
            readability_score: analysis.readabilityScore
        });

        console.log(`[DB] Competitor analysis saved for: ${analysis.keyword}`);
    } catch (err) {
        console.error('[DB] Error saving competitor analysis:', err);
    }
}

/**
 * Save internal link for graph analysis
 */
export async function saveInternalLink(link: {
    sourceSlug: string;
    targetSlug: string;
    anchorText: string;
    relevanceScore: number;
    positionInContent: number;
}): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    try {
        await client.from('internal_links').upsert({
            source_slug: link.sourceSlug,
            target_slug: link.targetSlug,
            anchor_text: link.anchorText,
            relevance_score: link.relevanceScore,
            position_in_content: link.positionInContent
        }, {
            onConflict: 'source_slug,target_slug,anchor_text'
        });
    } catch (err) {
        console.error('[DB] Error saving internal link:', err);
    }
}
