import { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

export const capabilitiesSwagger: SchemaObject = {
  type: 'object',
  description:
    'Adapter가 보고하는 자기 선언 capability. CLO-110(H-2-1)부터 서버가 provider별 상한(설계 06 §4.4 실측 선언값)으로 clamp한 뒤 저장·사용한다. ' +
    '상한보다 낮은 선언은 그대로 두지만 높은 선언은 깎이므로, 예를 들어 CODEX가 credentialPathDeny=true를 보내도 서버는 false로 본다. ' +
    '상한 표에 없는 provider는 securityTier=tier_c_unrestricted에 모든 강제 능력 false다. 저장된 값과 GET /v1/agents의 값은 모두 clamp 후의 값이다.',
  required: [
    'supportsResume',
    'supportsStructuredProgress',
    'supportsCancel',
    'supportsLayer1Patch',
    'securityTier',
    'supportedPolicyEnforcements',
  ],
  properties: {
    supportsResume: { type: 'boolean' },
    supportsStructuredProgress: { type: 'boolean' },
    supportsCancel: { type: 'boolean' },
    supportsLayer1Patch: { type: 'boolean' },
    securityTier: {
      type: 'string',
      enum: ['tier_a_hardened', 'tier_b_sandboxed', 'tier_c_unrestricted'],
    },
    supportedPolicyEnforcements: {
      type: 'object',
      required: ['toolDeny', 'networkDeny', 'destructiveCommandDeny', 'credentialPathDeny'],
      properties: Object.fromEntries(
        ['toolDeny', 'networkDeny', 'destructiveCommandDeny', 'credentialPathDeny'].map((key) => [
          key,
          { type: 'boolean' },
        ]),
      ),
    },
  },
};
