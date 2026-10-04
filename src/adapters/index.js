import { fetchGreenhouse, hasGreenhouse } from './greenhouse.js';
import { fetchLever, hasLever } from './lever.js';
import { fetchAshby, hasAshby } from './ashby.js';
import { fetchSmartrecruiters, hasSmartrecruiters } from './smartrecruiters.js';
import { fetchTeamtailor, hasTeamtailor } from './teamtailor.js';
import { fetchRecruitee, hasRecruitee } from './recruitee.js';
import { fetchWorkday, hasWorkday } from './workday.js';

export {
  fetchGreenhouse, hasGreenhouse,
  fetchLever, hasLever,
  fetchAshby, hasAshby,
  fetchSmartrecruiters, hasSmartrecruiters,
  fetchTeamtailor, hasTeamtailor,
  fetchRecruitee, hasRecruitee,
  fetchWorkday, hasWorkday,
};

export const ADAPTERS = {
  greenhouse: { fetch: fetchGreenhouse, has: hasGreenhouse },
  lever: { fetch: fetchLever, has: hasLever },
  ashby: { fetch: fetchAshby, has: hasAshby },
  smartrecruiters: { fetch: fetchSmartrecruiters, has: hasSmartrecruiters },
  teamtailor: { fetch: fetchTeamtailor, has: hasTeamtailor },
  recruitee: { fetch: fetchRecruitee, has: hasRecruitee },
  workday: { fetch: fetchWorkday, has: hasWorkday },
};

export const ATS_NAMES = Object.keys(ADAPTERS);
