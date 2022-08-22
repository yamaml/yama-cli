export const SHEX_TEMPLATE = `
#
# Generated from YAMA
# https://purl.org/yama/spec/latest
#
{%- for prefix, uri in namespaces %}
PREFIX {{prefix}}: <{{uri}}>
{%- endfor %}
BASE <{{base}}>

{%- for descriptionId, description in descriptions %}
<{{descriptionId}}> {
  {%- for statementId, statement in description.statements %}
  {{statement.property}} {{statement.propertyID}}
  {%- if not statement.datatype %} {{statement.type | default("LITERAL") |  upper }} {%- endif -%}
  {%- if statement.datatype %} {{statement.datatype}}{% endif -%}
  {%- if statement.facets.MaxInclusive %} MaxInclusive {{statement.facets.MaxInclusive}} {%- endif -%}
  {%- if statement.facets.MinInclusive %} MinInclusive {{statement.facets.MinInclusive}} {%- endif -%}
  {%- if statement.min or statement.max %} { {{-statement.min-}}
		  {%- if statement.max -%}
		   ,{{statement.max}}
		  {%- endif -%} }{%- endif -%}
  {%- if statement.description %} @<{{statement.description}}>{% endif -%}
  {%- if not loop.last -%} ;{%- endif -%}
  {%- endfor %}
}
{%- endfor %}
`;
