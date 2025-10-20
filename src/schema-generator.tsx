
import { GeneratedContent, SiteInfo, ExpandedGeoTargeting } from './index.tsx';

export type WpConfig = {
    url: string;
    username: string;
};

// =================================================================
// 💎 HIGH-QUALITY SCHEMA.ORG MARKUP GENERATOR
// =================================================================
// This module creates SEO-optimized JSON-LD schema markup.
// It follows Google's latest guidelines to improve search visibility,
// enhance SERP rankings, and increase eligibility for rich snippets.
// =================================================================


// --- FALLBACKS: Used if no specific info is provided ---
const ORGANIZATION_NAME = "Your Company Name";
const DEFAULT_AUTHOR_NAME = "Expert Author";
// --- END FALLBACKS ---


/**
 * Creates a 'Person' schema object.
 * @param siteInfo Object containing author name, URL, and social links.
 * @returns A Person schema object.
 */
function createPersonSchema(siteInfo: SiteInfo) {
    return {
        "@type": "Person",
        "name": siteInfo.authorName || DEFAULT_AUTHOR_NAME,
        "url": siteInfo.authorUrl || undefined,
        "sameAs": siteInfo.authorSameAs && siteInfo.authorSameAs.length > 0 ? siteInfo.authorSameAs : undefined,
    };
}

/**
 * Creates an 'Organization' schema object, used for the publisher property.
 * @param siteInfo Object containing organization name, URL, logo, and social links.
 * @returns An Organization schema object.
 */
function createOrganizationSchema(siteInfo: SiteInfo) {
    return {
        "@type": "Organization",
        "name": siteInfo.orgName || ORGANIZATION_NAME,
        "url": siteInfo.orgUrl,
        "logo": siteInfo.logoUrl ? {
            "@type": "ImageObject",
            "url": siteInfo.logoUrl,
        } : undefined,
        "sameAs": siteInfo.orgSameAs && siteInfo.orgSameAs.length > 0 ? siteInfo.orgSameAs : undefined,
    };
}

/**
 * Creates a 'LocalBusiness' schema object for geo-targeted content.
 * @param siteInfo The organization's base information.
 * @param geoTargeting The detailed location information.
 * @returns A LocalBusiness schema object.
 */
function createLocalBusinessSchema(siteInfo: SiteInfo, geoTargeting: ExpandedGeoTargeting) {
    return {
        "@type": "LocalBusiness",
        "name": siteInfo.orgName || ORGANIZATION_NAME,
        "url": siteInfo.orgUrl,
        "address": {
            "@type": "PostalAddress",
            "addressLocality": geoTargeting.location,
            "addressRegion": geoTargeting.region,
            "postalCode": geoTargeting.postalCode,
            "addressCountry": geoTargeting.country,
        },
    };
}


/**
 * Creates the core 'Article' schema.
 * @param content The fully generated content object.
 * @param wpConfig The WordPress configuration containing the site URL.
 * @param orgSchema The generated Organization schema for the publisher.
 * @param personSchema The generated Person schema for the author.
 * @returns An Article schema object.
 */
function createArticleSchema(content: GeneratedContent, wpConfig: WpConfig, orgSchema: object, personSchema: object) {
    const today = new Date().toISOString();
    return {
        "@type": "Article",
        "headline": content.title,
        "description": content.metaDescription,
        "image": content.imageDetails.map(img => img.generatedImageSrc).filter(Boolean),
        "datePublished": today,
        "dateModified": today,
        "author": personSchema,
        "publisher": orgSchema,
        "mainEntityOfPage": {
            "@type": "WebPage",
            "@id": `${wpConfig.url.replace(/\/+$/, '')}/${content.slug}`,
        },
        "keywords": content.semanticKeywords && content.semanticKeywords.length > 0 ? content.semanticKeywords.join(', ') : undefined,
    };
}

/**
 * Creates 'FAQPage' schema from structured data.
 * This is the preferred method as it's more reliable than HTML parsing.
 * @param faqData An array of question/answer objects.
 * @returns An FAQPage schema object, or null if no valid FAQs are provided.
 */
function createFaqSchema(faqData: { question: string, answer: string }[]) {
    if (!faqData || faqData.length === 0) {
        return null;
    }
    
    const mainEntity = faqData
        .filter(faq => faq.question && faq.answer)
        .map(faq => ({
            "@type": "Question",
            "name": faq.question,
            "acceptedAnswer": {
                "@type": "Answer",
                "text": faq.answer,
            },
        }));

    if (mainEntity.length === 0) return null;

    return {
        "@type": "FAQPage",
        "mainEntity": mainEntity,
    };
}

/**
 * [Fallback] Creates 'FAQPage' schema by parsing questions and answers from the final HTML content.
 * This version is improved to be more robust.
 * @param content The fully generated content object.
 * @returns An FAQPage schema object, or null if no valid FAQs are found.
 */
function createFaqSchemaFromHtml(content: GeneratedContent) {
    const mainEntity = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content.content;
    
    const headings = tempDiv.querySelectorAll('h2, h3');
    
    for (const heading of headings) {
        const questionText = heading.textContent?.trim();
        if (questionText && questionText.endsWith('?') && questionText.split(' ').length > 3) {
            let nextElement = heading.nextElementSibling;
            let answerText = '';
            let elementsInAnswer = 0;
            
            while (nextElement && !['H2', 'H3', 'H4'].includes(nextElement.tagName) && elementsInAnswer < 3) {
                if (nextElement.tagName === 'P' || nextElement.tagName === 'UL' || nextElement.tagName === 'OL') {
                    answerText += nextElement.textContent + ' ';
                    elementsInAnswer++;
                }
                nextElement = nextElement.nextElementSibling;
            }
            
            if (answerText) {
                mainEntity.push({
                    "@type": "Question",
                    "name": questionText,
                    "acceptedAnswer": {
                        "@type": "Answer",
                        "text": answerText.trim(),
                    },
                });
            }
        }
    }

    if (mainEntity.length === 0) return null;

    return {
        "@type": "FAQPage",
        "mainEntity": mainEntity,
    };
}


/**
 * Creates 'VideoObject' schemas for all embedded YouTube videos in the content.
 * @param content The fully generated content object.
 * @returns An array of VideoObject schemas, or null if no videos are found.
 */
function createVideoObjectSchemas(content: GeneratedContent) {
    const schemas = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content.content;
    const iframes = tempDiv.querySelectorAll('iframe[src*="youtube.com/embed/"]');
    
    iframes.forEach(iframe => {
        const videoIdMatch = (iframe as HTMLIFrameElement).src.match(/embed\/([^?&]+)/);
        if (videoIdMatch) {
            schemas.push({
                "@type": "VideoObject",
                "name": (iframe as HTMLIFrameElement).title || content.title,
                "description": content.metaDescription,
                "thumbnailUrl": `https://i.ytimg.com/vi/${videoIdMatch[1]}/maxresdefault.jpg`,
                "uploadDate": new Date().toISOString(),
                "embedUrl": (iframe as HTMLIFrameElement).src,
            });
        }
    });

    return schemas.length > 0 ? schemas : null;
}

/**
 * Creates 'AudioObject' schemas for all embedded audio files in the content.
 * @param content The fully generated content object.
 * @param orgSchema The organization schema to use as the publisher.
 * @returns An array of AudioObject schemas, or null if no audio is found.
 */
function createAudioObjectSchemas(content: GeneratedContent, orgSchema: object) {
    const schemas = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content.content;
    const audioElements = tempDiv.querySelectorAll('audio');

    audioElements.forEach(audio => {
        const src = audio.querySelector('source')?.src || audio.src;
        if (src) {
            schemas.push({
                "@type": "AudioObject",
                "contentUrl": src,
                "name": content.title,
                "description": content.metaDescription,
                "encodingFormat": "audio/mpeg", // A common default
                "publisher": orgSchema,
                "uploadDate": new Date().toISOString(),
            });
        }
    });

    return schemas.length > 0 ? schemas : null;
}

/**
 * The main exported function. It assembles all relevant schema types into a single
 * '@graph' object, which is the recommended way to include multiple schemas on a page.
 * @param content The complete generated content object after all stages.
 * @param wpConfig The WordPress configuration with site URL.
 * @param siteInfo The site-wide information for publisher and author.
 * @param faqData Optional structured FAQ data for more reliable schema generation.
 * @param geoTargeting Optional geo-targeting settings to trigger LocalBusiness schema.
 * @returns A complete schema.org JSON-LD object.
 */
export function generateFullSchema(
    content: GeneratedContent,
    wpConfig: WpConfig,
    siteInfo: SiteInfo,
    faqData?: { question: string, answer: string }[],
    geoTargeting?: ExpandedGeoTargeting
): object {
    const schemas = [];
    
    const organizationSchema = createOrganizationSchema(siteInfo);
    const personSchema = createPersonSchema(siteInfo);

    const articleSchema = createArticleSchema(content, wpConfig, organizationSchema, personSchema);
    schemas.push(articleSchema);

    const faqSchema = faqData ? createFaqSchema(faqData) : createFaqSchemaFromHtml(content);
    if (faqSchema) schemas.push(faqSchema);

    const videoSchemas = createVideoObjectSchemas(content);
    if (videoSchemas) schemas.push(...videoSchemas);
    
    const audioSchemas = createAudioObjectSchemas(content, organizationSchema);
    if (audioSchemas) schemas.push(...audioSchemas);

    if (geoTargeting?.enabled && geoTargeting.location) {
        const localBusinessSchema = createLocalBusinessSchema(siteInfo, geoTargeting);
        schemas.push(localBusinessSchema);
    }

    return {
      "@context": "https://schema.org",
      "@graph": schemas,
    };
}

/**
 * Wraps the generated schema object in a `<script>` tag for embedding in HTML.
 * @param schemaObject The final JSON-LD object from generateFullSchema.
 * @returns A string containing the full schema script tag.
 */
export function generateSchemaMarkup(schemaObject: object): string {
    if (!schemaObject || !Object.prototype.hasOwnProperty.call(schemaObject, '@graph') || (schemaObject as any)['@graph'].length === 0) {
        return '';
    }
    const schemaScript = `<script type="application/ld+json">\n${JSON.stringify(schemaObject, null, 2)}\n</script>`;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // CRITICAL FIX FOR VISIBLE SCHEMA MARKUP
    // ════════════════════════════════════════════════════════════════════════════════
    // The WordPress REST API's 'content' field is aggressively sanitized to prevent
    // security vulnerabilities like Cross-Site Scripting (XSS). This process correctly
    // strips raw <script> tags, which was causing the JSON-LD content to be rendered
    // as visible plain text at the end of the post.
    //
    // The ONLY standard, reliable method to insert a raw script block via the REST API
    // is to wrap it in a Gutenberg "Custom HTML" block. The `<!-- wp:html -->` comments
    // are instructions for the block editor, telling it to preserve the enclosed content
    // exactly as-is, without filtering it. This ensures the <script> tag is correctly
    // embedded in the page's HTML and remains invisible to the reader, as intended.
    // ════════════════════════════════════════════════════════════════════════════════
    return `\n\n<!-- wp:html -->\n${schemaScript}\n<!-- /wp:html -->\n\n`;
}
