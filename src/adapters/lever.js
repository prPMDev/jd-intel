import { normalize } from '../normalizer.js';

const BASE_URL = 'https://api.lever.co/v0/postings';

/**
 * Fetch all jobs from a Lever job board.
 * Public API, no auth required.
 *
 * @param {string} slug - Company slug (e.g., 'stripe', 'figma')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchLever(slug) {
  const url = `${BASE_URL}/${slug}?mode=json`;
  const resp = await fetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`Lever API error for ${slug}: ${resp.status}`);
  }

  const jobs = await resp.json();
  if (!Array.isArray(jobs)) return [];

  return jobs.map(job => {
    const salary = parseLeverSalary(job.categories?.commitment, job.text);

    return normalize({
      companySlug: slug,
      company: job.categories?.team || slug,
      title: job.text || '',
      department: job.categories?.department || job.categories?.team || '',
      location: job.categories?.location || '',
      description: stripHtml(job.descriptionPlain || job.description || ''),
      url: job.hostedUrl || '',
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      salary,
      metadata: {
        leverId: job.id,
        team: job.categories?.team || '',
        commitment: job.categories?.commitment || '', // Full-time, Part-time, etc.
        workplaceType: job.workplaceType || '',
      },
    }, 'lever');
  });
}

function parseLeverSalary(commitment, title) {
  // Lever doesn't have a salary field, but sometimes it's in the title
  const match = (title || '').match(/\$[\d,]+\s*[-–]\s*\$[\d,]+/);
  if (!match) return null;
  const nums = match[0].match(/[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  return {
    min: parseInt(nums[0].replace(/,/g, '')),
    max: parseInt(nums[1].replace(/,/g, '')),
    currency: 'USD',
  };
}

export async function hasLever(slug) {
  try {
    const resp = await fetch(`${BASE_URL}/${slug}?mode=json`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}
