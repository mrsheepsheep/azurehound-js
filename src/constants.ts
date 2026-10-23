export const resourceDefinitions: any[] = [
    ['AZResourceGroup', sid => `/subscriptions/${sid}/resourcegroups`, '2021-04-01'],
    ['AZVM', sid => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachines`, '2024-07-01'],
    ['AZVMScaleSet', sid => `/subscriptions/${sid}/providers/Microsoft.Compute/virtualMachineScaleSets`, '2024-07-01'],
    ['AZKeyVault', sid => `/subscriptions/${sid}/providers/Microsoft.KeyVault/vaults`, '2023-07-01'],
    ['AZStorageAccount', sid => `/subscriptions/${sid}/providers/Microsoft.Storage/storageAccounts`, '2023-01-01'],
    ['AZAutomationAccount', sid => `/subscriptions/${sid}/providers/Microsoft.Automation/automationAccounts`, '2023-11-01'],
    ['AZLogicApp', sid => `/subscriptions/${sid}/providers/Microsoft.Logic/workflows`, '2019-05-01'],
    ['AZFunctionApp', sid => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, '2023-12-01', item => item.kind?.toLowerCase() === 'functionapp'],
    ['AZWebApp', sid => `/subscriptions/${sid}/providers/Microsoft.Web/sites`, '2023-12-01', item => item.kind?.toLowerCase() === 'app'],
    ['AZContainerRegistry', sid => `/subscriptions/${sid}/providers/Microsoft.ContainerRegistry/registries`, '2023-07-01'],
    ['AZManagedCluster', sid => `/subscriptions/${sid}/providers/Microsoft.ContainerService/managedClusters`, '2024-05-01']
  ];
export const roleIds = {
    owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
    contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
    userAccessAdmin: '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
    kvContributor: 'f25e0fa2-a7c8-4377-a976-54943a77a395',
    avereContributor: '4f8fab4f-1852-4a58-a46a-8eaf358af14a',
    adminLogin: '1c0163c0-47e6-4577-8991-ea5c82e286e4',
    vmContributor: '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
  };
export const derivedRoles = {
    AZSubscriptionRoleAssignment: [['AZSubscriptionOwner', 'owner', 'owners'], ['AZSubscriptionContributor', 'contributor', 'contributors'], ['AZSubscriptionUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZManagementGroupRoleAssignment: [['AZManagementGroupOwner', 'owner', 'owners'], ['AZManagementGroupContributor', 'contributor', 'contributors'], ['AZManagementGroupUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZResourceGroupRoleAssignment: [['AZResourceGroupOwner', 'owner', 'owners'], ['AZResourceGroupContributor', 'contributor', 'contributors'], ['AZResourceGroupUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins']],
    AZKeyVaultRoleAssignment: [['AZKeyVaultOwner', 'owner', 'owners'], ['AZKeyVaultContributor', 'contributor', 'contributors'], ['AZKeyVaultUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins'], ['AZKeyVaultKVContributor', 'kvContributor', 'kvContributors']],
    AZVMRoleAssignment: [['AZVMOwner', 'owner', 'owners'], ['AZVMContributor', 'contributor', 'contributors'], ['AZVMUserAccessAdmin', 'userAccessAdmin', 'userAccessAdmins'], ['AZVMAvereContributor', 'avereContributor', 'avereContributors'], ['AZVMAdminLogin', 'adminLogin', 'adminLogins'], ['AZVMVMContributor', 'vmContributor', 'vmContributors']]
  };
export const graphRecordKinds = {
    AZUser: ['AZUser'], AZGroup: ['AZGroup', 'AZGroupMember', 'AZGroupOwner'],
    AZApp: ['AZApp', 'AZAppOwner', 'AZFederatedIdentityCredential'],
    AZServicePrincipal: ['AZServicePrincipal', 'AZServicePrincipalOwner', 'AZAppRoleAssignment'],
    AZDevice: ['AZDevice'],
    AZRole: ['AZRole', 'AZRoleAssignment', 'AZRoleEligibilityScheduleInstance', 'AZRoleManagementPolicyAssignment']
  };
export function recordKindsFor(category) {
    if (graphRecordKinds[category]) return graphRecordKinds[category];
    if (category === 'AZSubscription') return ['AZSubscription', 'AZSubscriptionRoleAssignment',
      ...(derivedRoles.AZSubscriptionRoleAssignment || []).map(([kind]) => kind), 'AZTenant'];
    if (category === 'AZManagementGroup') return ['AZManagementGroup', 'AZManagementGroupDescendant',
      'AZManagementGroupRoleAssignment', ...(derivedRoles.AZManagementGroupRoleAssignment || []).map(([kind]) => kind)];
    const roleKind = category === 'AZVM' ? 'AZVMRoleAssignment' : `${category}RoleAssignment`;
    return [category, roleKind, ...(derivedRoles[roleKind] || []).map(([kind]) => kind),
      ...(category === 'AZKeyVault' ? ['AZKeyVaultAccessPolicy'] : []),
      ...(category === 'AZStorageAccount' ? ['AZStorageContainer'] : [])];
  }
export const graphOptions = [
    ['AZUser', 'Users'], ['AZGroup', 'Groups, members, and owners'],
    ['AZApp', 'Registered applications, owners, and credentials'],
    ['AZServicePrincipal', 'Service principals, owners, and app roles'],
    ['AZDevice', 'Devices'], ['AZRole', 'Directory roles, assignments, and policies']
  ];
export const armOptions = [['AZManagementGroup', 'Management groups'],
    ...resourceDefinitions.map(([kind]) => [kind, kind.replace(/^AZ/, '').replace(/([a-z])([A-Z])/g, '$1 $2')])];
export const graphCountQueries: any[] = [
    ['AZUser', '/v1.0/users', {}],
    ['AZGroup', '/v1.0/groups', { '$filter': 'securityEnabled eq true' }],
    ['AZApp', '/v1.0/applications', {}],
    ['AZServicePrincipal', '/v1.0/servicePrincipals', {}],
    ['AZDevice', '/v1.0/devices', {}],
    ['AZRole', '/v1.0/roleManagement/directory/roleDefinitions', {}]
  ];
export const armResourceTypes = {
    AZVM: 'microsoft.compute/virtualmachines', AZVMScaleSet: 'microsoft.compute/virtualmachinescalesets',
    AZKeyVault: 'microsoft.keyvault/vaults', AZStorageAccount: 'microsoft.storage/storageaccounts',
    AZAutomationAccount: 'microsoft.automation/automationaccounts', AZLogicApp: 'microsoft.logic/workflows',
    AZFunctionApp: 'microsoft.web/sites', AZWebApp: 'microsoft.web/sites',
    AZContainerRegistry: 'microsoft.containerregistry/registries',
    AZManagedCluster: 'microsoft.containerservice/managedclusters'
  };
