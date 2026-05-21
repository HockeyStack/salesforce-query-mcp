import { SalesforceClient } from "../SalesforceClient.js";
import { runWithConcurrency } from "../utils.js";

export interface PicklistValueEntry {
  label: string;
  value: string;
  isActive: boolean;
}

export interface RecordTypePicklistResult {
  recordTypeId: string;
  recordTypeName: string;
  recordTypeDeveloperName: string;
  isMaster: boolean;
  isActive: boolean;
  values: PicklistValueEntry[];
  error: string | null;
}

/**
 * Returns picklist values for a given field, broken down by record type.
 * Uses the UI API (/ui-api/object-info/.../picklist-values/...) which returns
 * active values per record type without requiring the SOAP Metadata API.
 */
export async function getPicklistValuesByRecordType(
  client: SalesforceClient,
  objectApiName: string,
  fieldApiName: string
): Promise<RecordTypePicklistResult[]> {
  // 1. Get all active record types via SOQL
  const rtRecords = await client.queryPaginated(
    `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SobjectType = '${objectApiName}' ORDER BY Name ASC`
  );

  // 2. Get the Master record type ID from the object describe (it doesn't appear in SOQL)
  const describe = await client.request(`/sobjects/${objectApiName}/describe`);
  const masterRtInfo = (describe.recordTypeInfos ?? []).find(
    (rti: any) => rti.master === true
  );

  // Build the full list of record types to check, starting with Master
  const allRecordTypes: Array<{
    id: string;
    name: string;
    developerName: string;
    isMaster: boolean;
    isActive: boolean;
  }> = [];

  if (masterRtInfo) {
    allRecordTypes.push({
      id: masterRtInfo.recordTypeId,
      name: "Master",
      developerName: "Master",
      isMaster: true,
      isActive: true,
    });
  }

  for (const rt of rtRecords) {
    allRecordTypes.push({
      id: rt.Id,
      name: rt.Name,
      developerName: rt.DeveloperName,
      isMaster: false,
      isActive: rt.IsActive,
    });
  }

  // 3. Fetch picklist values for each record type via the UI API
  const results = await runWithConcurrency(
    allRecordTypes.map((rt) => async (): Promise<RecordTypePicklistResult> => {
      try {
        const data = await client.request(
          `/ui-api/object-info/${objectApiName}/picklist-values/${rt.id}/${fieldApiName}`
        );

        const values: PicklistValueEntry[] = (data.values ?? []).map(
          (v: any) => ({
            label: v.label,
            value: v.value,
            isActive: true, // UI API only returns active values for the given record type
          })
        );

        return {
          recordTypeId: rt.id,
          recordTypeName: rt.name,
          recordTypeDeveloperName: rt.developerName,
          isMaster: rt.isMaster,
          isActive: rt.isActive,
          values,
          error: null,
        };
      } catch (err) {
        return {
          recordTypeId: rt.id,
          recordTypeName: rt.name,
          recordTypeDeveloperName: rt.developerName,
          isMaster: rt.isMaster,
          isActive: rt.isActive,
          values: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
    5
  );

  return results;
}
