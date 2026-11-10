import { useState } from 'react';
import { HoursView } from './HoursView';
import { ReviewView } from './ReviewView';

type HoursTab = 'report' | 'review';
/** 按需挂载标签，访问后保留状态，切换时不清空报表或重复读取。 */
export function HoursWorkspace({ projectKey, onOpen, tab, onTabChange }: {
  projectKey: string | null; onOpen: (key: string) => void;
  tab: HoursTab; onTabChange: (tab: HoursTab) => void;
}) {
  const [visited, setVisited] = useState(() => new Set<HoursTab>([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  return <div className="hours-workspace">
    <div className="hours-page-tabs" role="tablist" aria-label="工时页面">
      <button id="hours-report-tab" role="tab" aria-selected={tab === 'report'} aria-controls="hours-report-panel" onClick={() => onTabChange('report')}>统计报表</button>
      <button id="hours-review-tab" role="tab" aria-selected={tab === 'review'} aria-controls="hours-review-panel" onClick={() => onTabChange('review')}>检查与汇总</button>
    </div>
    <div id="hours-report-panel" role="tabpanel" aria-labelledby="hours-report-tab" hidden={tab !== 'report'}>
      {visited.has('report') && <HoursView projectKey={projectKey} onOpen={onOpen}/>}
    </div>
    <div id="hours-review-panel" role="tabpanel" aria-labelledby="hours-review-tab" hidden={tab !== 'review'}>
      {visited.has('review') && <ReviewView projectKey={projectKey} onOpen={onOpen}/>}
    </div>
  </div>;
}
