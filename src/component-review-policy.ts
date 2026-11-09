import type { ComponentReviewState, ComponentTypeDefinition } from '../shared/configuration-revisions'

export const componentPolicyStatus = (type: ComponentTypeDefinition): ComponentReviewState => type.reviewState || (type.disabled ? 'disabled' : 'active')
export const componentPolicyActionState = (action: 'enable' | 'restore' | 'disable' | 'remove'): ComponentReviewState => action === 'disable' ? 'disabled' : action === 'remove' ? 'removed' : 'active'
export const visibleComponentTypes = (types: readonly ComponentTypeDefinition[], showRemoved: boolean): ComponentTypeDefinition[] => types.filter(type => showRemoved || componentPolicyStatus(type) !== 'removed')
export const componentTypeBlocksNewEntries = (type: ComponentTypeDefinition, policyEnabled?: boolean): boolean => Boolean(type.pendingRestore || !policyEnabled && type.disabled)
export const showWorkingComponentType = (type: ComponentTypeDefinition, policyEnabled: boolean | undefined, hasRecords: boolean): boolean => Boolean(policyEnabled || !type.disabled || hasRecords)
