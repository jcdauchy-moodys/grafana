import {
  AnnotationEvent,
  ArrayDataFrame,
  ArrayVector,
  DataFrame,
  DataTopic,
  Field,
  FieldType,
  formatLabels,
  MutableField,
  ScopedVars,
  TIME_SERIES_TIME_FIELD_NAME,
  TIME_SERIES_VALUE_FIELD_NAME,
} from '@grafana/data';
import { FetchResponse } from '@grafana/runtime';
import { getTemplateSrv } from 'app/features/templating/template_srv';
import {
  Exemplar,
  ExemplarTraceIDDestination,
  isExemplarData,
  isMatrixData,
  MatrixOrVectorResult,
  PromDataSuccessResponse,
  PromMetric,
  PromQuery,
  PromQueryRequest,
  PromValue,
  TransformOptions,
} from './types';

export function transform(
  response: FetchResponse<PromDataSuccessResponse>,
  transformOptions: {
    query: PromQueryRequest;
    exemplarTraceIDDestination?: ExemplarTraceIDDestination;
    target: PromQuery;
    responseListLength: number;
    scopedVars?: ScopedVars;
    mixedQueries?: boolean;
  }
) {
  // Create options object from transformOptions
  const options: TransformOptions = {
    format: transformOptions.target.format,
    step: transformOptions.query.step,
    legendFormat: transformOptions.target.legendFormat,
    start: transformOptions.query.start,
    end: transformOptions.query.end,
    query: transformOptions.query.expr,
    responseListLength: transformOptions.responseListLength,
    scopedVars: transformOptions.scopedVars,
    refId: transformOptions.target.refId,
    valueWithRefId: transformOptions.target.valueWithRefId,
    meta: {
      /**
       * Fix for showing of Prometheus results in Explore table.
       * We want to show result of instant query always in table and result of range query based on target.runAll;
       */
      preferredVisualisationType: getPreferredVisualisationType(
        transformOptions.query.instant,
        transformOptions.mixedQueries
      ),
    },
  };
  const prometheusResult = response.data.data;

  if (isExemplarData(prometheusResult)) {
    const events: AnnotationEvent[] = [];
    prometheusResult.forEach(exemplarData => {
      const data = exemplarData.exemplars.map(exemplar => {
        return {
          time: exemplar.timestamp,
          text: getText(exemplar, exemplarData.seriesLabels, transformOptions.exemplarTraceIDDestination),
        } as AnnotationEvent;
      });
      events.push(...data);
    });

    const range = Math.ceil(options.end - options.start);

    const divider = Math.max(range / 60 / 15, 4);

    const dataFrame = new ArrayDataFrame(events.filter((_, i) => i % divider === 0));
    dataFrame.meta = { dataTopic: DataTopic.Annotations };
    return [dataFrame];
  }

  if (!prometheusResult?.result) {
    return [];
  }

  // Return early if result type is scalar
  if (prometheusResult.resultType === 'scalar') {
    return [
      {
        meta: options.meta,
        refId: options.refId,
        length: 1,
        fields: [getTimeField([prometheusResult.result]), getValueField([prometheusResult.result])],
      },
    ];
  }

  // Return early again if the format is table, this needs special transformation.
  if (options.format === 'table') {
    const tableData = transformMetricDataToTable(prometheusResult.result, options);
    return [tableData];
  }

  // Process matrix and vector results to DataFrame
  const dataFrame: DataFrame[] = [];
  prometheusResult.result.forEach((data: MatrixOrVectorResult) => dataFrame.push(transformToDataFrame(data, options)));

  // When format is heatmap use the already created data frames and transform it more
  if (options.format === 'heatmap') {
    dataFrame.sort(sortSeriesByLabel);
    const seriesList = transformToHistogramOverTime(dataFrame);
    return seriesList;
  }

  // Return matrix or vector result as DataFrame[]
  return dataFrame;
}

function getText(
  exemplar: Exemplar,
  seriesLabels: PromMetric,
  exemplarTraceIDDestination?: ExemplarTraceIDDestination
) {
  let traceID = exemplar.labels.traceID;
  const template = `
    <div>
      <ul>
      ${Object.keys(seriesLabels)
        .map(label => `<li>${label}: ${seriesLabels[label]}</li>`)
        .join('\n')}
      </ul>
    </div>`;
  if (exemplarTraceIDDestination) {
    traceID = exemplar.labels[exemplarTraceIDDestination.name];
    const href = exemplarTraceIDDestination.url.replace('${value}', traceID);
    const anchorElement = `<a href="${href}" rel="noopener" target="_blank">Go to ${traceID}</a>`;
    return template + anchorElement;
  }
  return template;
}

function getPreferredVisualisationType(isInstantQuery?: boolean, mixedQueries?: boolean) {
  if (isInstantQuery) {
    return 'table';
  }

  return mixedQueries ? 'graph' : undefined;
}

/**
 * Transforms matrix and vector result from Prometheus result to DataFrame
 */
function transformToDataFrame(data: MatrixOrVectorResult, options: TransformOptions): DataFrame {
  const { name } = createLabelInfo(data.metric, options);

  const fields: Field[] = [];

  if (isMatrixData(data)) {
    const stepMs = options.step ? options.step * 1000 : NaN;
    let baseTimestamp = options.start * 1000;
    const dps: PromValue[] = [];

    for (const value of data.values) {
      let dpValue: number | null = parseFloat(value[1]);

      if (isNaN(dpValue)) {
        dpValue = null;
      }

      const timestamp = value[0] * 1000;
      for (let t = baseTimestamp; t < timestamp; t += stepMs) {
        dps.push([t, null]);
      }
      baseTimestamp = timestamp + stepMs;
      dps.push([timestamp, dpValue]);
    }

    const endTimestamp = options.end * 1000;
    for (let t = baseTimestamp; t <= endTimestamp; t += stepMs) {
      dps.push([t, null]);
    }
    fields.push(getTimeField(dps, true));
    fields.push(getValueField(dps, undefined, false));
  } else {
    fields.push(getTimeField([data.value]));
    fields.push(getValueField([data.value]));
  }

  return {
    meta: options.meta,
    refId: options.refId,
    length: fields[0].values.length,
    fields,
    name,
  };
}

function transformMetricDataToTable(md: MatrixOrVectorResult[], options: TransformOptions): DataFrame {
  if (!md || md.length === 0) {
    return {
      meta: options.meta,
      refId: options.refId,
      length: 0,
      fields: [],
    };
  }

  const valueText = options.responseListLength > 1 || options.valueWithRefId ? `Value #${options.refId}` : 'Value';

  const timeField = getTimeField([]);
  const metricFields = Object.keys(md.reduce((acc, series) => ({ ...acc, ...series.metric }), {}))
    .sort()
    .map(label => {
      return {
        name: label,
        config: { filterable: true },
        type: FieldType.other,
        values: new ArrayVector(),
      };
    });
  const valueField = getValueField([], valueText);

  md.forEach(d => {
    if (isMatrixData(d)) {
      d.values.forEach(val => {
        timeField.values.add(val[0] * 1000);
        metricFields.forEach(metricField => metricField.values.add(getLabelValue(d.metric, metricField.name)));
        valueField.values.add(parseFloat(val[1]));
      });
    } else {
      timeField.values.add(d.value[0] * 1000);
      metricFields.forEach(metricField => metricField.values.add(getLabelValue(d.metric, metricField.name)));
      valueField.values.add(parseFloat(d.value[1]));
    }
  });

  return {
    meta: options.meta,
    refId: options.refId,
    length: timeField.values.length,
    fields: [timeField, ...metricFields, valueField],
  };
}

function getLabelValue(metric: PromMetric, label: string): string | number {
  if (metric.hasOwnProperty(label)) {
    if (label === 'le') {
      return parseHistogramLabel(metric[label]);
    }
    return metric[label];
  }
  return '';
}

function getTimeField(data: PromValue[], isMs = false): MutableField {
  return {
    name: TIME_SERIES_TIME_FIELD_NAME,
    type: FieldType.time,
    config: {},
    values: new ArrayVector<number>(data.map(val => (isMs ? val[0] : val[0] * 1000))),
  };
}

function getValueField(
  data: PromValue[],
  valueName: string = TIME_SERIES_VALUE_FIELD_NAME,
  parseValue = true
): MutableField {
  return {
    name: valueName,
    type: FieldType.number,
    config: {},
    values: new ArrayVector<number | null>(data.map(val => (parseValue ? parseFloat(val[1]) : val[1]))),
  };
}

function createLabelInfo(labels: { [key: string]: string }, options: TransformOptions) {
  if (options?.legendFormat) {
    const title = renderTemplate(getTemplateSrv().replace(options.legendFormat, options?.scopedVars), labels);
    return { name: title, labels };
  }

  const { __name__, ...labelsWithoutName } = labels;
  const labelPart = formatLabels(labelsWithoutName);
  const title = `${__name__ ?? ''}${labelPart}`;

  return { name: title, labels: labelsWithoutName };
}

export function getOriginalMetricName(labelData: { [key: string]: string }) {
  const metricName = labelData.__name__ || '';
  delete labelData.__name__;
  const labelPart = Object.entries(labelData)
    .map(label => `${label[0]}="${label[1]}"`)
    .join(',');
  return `${metricName}{${labelPart}}`;
}

export function renderTemplate(aliasPattern: string, aliasData: { [key: string]: string }) {
  const aliasRegex = /\{\{\s*(.+?)\s*\}\}/g;
  return aliasPattern.replace(aliasRegex, (_match, g1) => {
    if (aliasData[g1]) {
      return aliasData[g1];
    }
    return '';
  });
}

function transformToHistogramOverTime(seriesList: DataFrame[]) {
  /*      t1 = timestamp1, t2 = timestamp2 etc.
            t1  t2  t3          t1  t2  t3
    le10    10  10  0     =>    10  10  0
    le20    20  10  30    =>    10  0   30
    le30    30  10  35    =>    10  0   5
    */
  for (let i = seriesList.length - 1; i > 0; i--) {
    const topSeries = seriesList[i].fields.find(s => s.name === TIME_SERIES_VALUE_FIELD_NAME);
    const bottomSeries = seriesList[i - 1].fields.find(s => s.name === TIME_SERIES_VALUE_FIELD_NAME);
    if (!topSeries || !bottomSeries) {
      throw new Error('Prometheus heatmap transform error: data should be a time series');
    }

    for (let j = 0; j < topSeries.values.length; j++) {
      const bottomPoint = bottomSeries.values.get(j) || [0];
      topSeries.values.toArray()[j] -= bottomPoint;
    }
  }

  return seriesList;
}

function sortSeriesByLabel(s1: DataFrame, s2: DataFrame): number {
  let le1, le2;

  try {
    // fail if not integer. might happen with bad queries
    le1 = parseHistogramLabel(s1.name ?? '');
    le2 = parseHistogramLabel(s2.name ?? '');
  } catch (err) {
    console.error(err);
    return 0;
  }

  if (le1 > le2) {
    return 1;
  }

  if (le1 < le2) {
    return -1;
  }

  return 0;
}

function parseHistogramLabel(le: string): number {
  if (le === '+Inf') {
    return +Infinity;
  }
  return Number(le);
}
