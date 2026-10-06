/** Generated AppSpec v1 tool schema; source: Core app-runtime/contract.js APP_SPEC_TOOL_SCHEMA. */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

/** Data-only AppSpec schema; Core enforces size, identifiers and references. */
export const appSpecSchema: JsonSchemaNode = {
  'type': 'object',
  'additionalProperties': false,
  'required': [
    'schemaVersion',
    'name',
    'entities',
    'views',
  ],
  'properties': {
    'schemaVersion': {
      'type': 'integer',
      'const': 1,
    },
    'name': {
      'type': 'string',
    },
    'description': {
      'type': 'string',
    },
    'entities': {
      'type': 'array',
      'items': {
        'type': 'object',
        'additionalProperties': false,
        'required': [
          'id',
          'name',
          'fields',
        ],
        'properties': {
          'id': {
            'type': 'string',
          },
          'name': {
            'type': 'string',
          },
          'fields': {
            'type': 'array',
            'items': {
              'oneOf': [
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'text',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                  ],
                },
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'number',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                  ],
                },
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'date',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                  ],
                },
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'enum',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                    'options': {
                      'type': 'array',
                      'items': {
                        'type': 'string',
                      },
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                    'options',
                  ],
                },
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'boolean',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                  ],
                },
                {
                  'type': 'object',
                  'additionalProperties': false,
                  'properties': {
                    'id': {
                      'type': 'string',
                    },
                    'name': {
                      'type': 'string',
                    },
                    'type': {
                      'type': 'string',
                      'const': 'reference',
                    },
                    'required': {
                      'type': 'boolean',
                    },
                    'source': {
                      'oneOf': [
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'local',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'derived',
                            },
                          },
                        },
                        {
                          'type': 'object',
                          'additionalProperties': false,
                          'required': [
                            'type',
                            'provider',
                            'object',
                            'property',
                          ],
                          'properties': {
                            'type': {
                              'type': 'string',
                              'const': 'external',
                            },
                            'provider': {
                              'type': 'string',
                            },
                            'object': {
                              'type': 'string',
                            },
                            'property': {
                              'type': 'string',
                            },
                          },
                        },
                      ],
                    },
                    'targetEntityId': {
                      'type': 'string',
                    },
                  },
                  'required': [
                    'id',
                    'name',
                    'type',
                    'targetEntityId',
                  ],
                },
              ],
            },
          },
        },
      },
    },
    'relations': {
      'type': 'array',
      'items': {
        'type': 'object',
        'additionalProperties': false,
        'required': [
          'id',
          'name',
          'fromEntityId',
          'toEntityId',
          'cardinality',
        ],
        'properties': {
          'id': {
            'type': 'string',
          },
          'name': {
            'type': 'string',
          },
          'fromEntityId': {
            'type': 'string',
          },
          'toEntityId': {
            'type': 'string',
          },
          'cardinality': {
            'type': 'string',
            'enum': [
              'one_to_one',
              'one_to_many',
              'many_to_many',
            ],
          },
        },
      },
    },
    'views': {
      'type': 'array',
      'items': {
        'type': 'object',
        'additionalProperties': false,
        'required': [
          'id',
          'name',
          'type',
          'entityId',
        ],
        'properties': {
          'id': {
            'type': 'string',
          },
          'name': {
            'type': 'string',
          },
          'type': {
            'type': 'string',
            'enum': [
              'table',
              'kanban',
              'record',
            ],
          },
          'entityId': {
            'type': 'string',
          },
          'fieldIds': {
            'type': 'array',
            'items': {
              'type': 'string',
            },
          },
          'groupByFieldId': {
            'type': 'string',
          },
        },
      },
    },
  },
}
