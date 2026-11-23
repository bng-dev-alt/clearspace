// Owner-only cesta pro stávající AI funkci (/api/ai/analyze-resource drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/analyze-resource/route';
